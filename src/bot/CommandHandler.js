const { REST, Routes, SlashCommandBuilder } = require('discord.js');
const path = require('path');
const config = require('../config');
const logger = require('../utils/logger');
const voiceRecorder = require('../audio/VoiceRecorder');
const audioProcessor = require('../audio/AudioProcessor');
const fileManager = require('../utils/fileManager');
const transcriptionService = require('../services/TranscriptionService');
const summarizationService = require('../services/SummarizationService');
const titleGenerationService = require('../services/TitleGenerationService');
const { _COMMANDS, _ERROR_MESSAGES } = require('../constants');

class CommandHandler {
    constructor(client, expressServer) {
        this.client = client;
        this.expressServer = expressServer;
        this.commands = new Map();
        this.setupCommands();
        this.setupAutocomplete();
    }

    // Helper to create web viewer link for transcript
    createTranscriptViewerLink(transcriptFilename) {
        const recordingId = transcriptFilename.replace('transcript_', '').replace('.md', '');
        return `${config.express.baseUrl}/?id=${recordingId}`;
    }

    setupAutocomplete() {
        this.client.on('interactionCreate', async (interaction) => {
            if (!interaction.isAutocomplete()) {
                return;
            }

            if (interaction.commandName === 'summarize') {
                await this.handleSummarizeAutocomplete(interaction);
            }
        });
    }

    setupCommands() {
        this.commands.set('join', {
            data: new SlashCommandBuilder()
                .setName('join')
                .setDescription('Join your voice channel and start recording'),
            execute: this.handleJoin.bind(this)
        });

        this.commands.set('stop', {
            data: new SlashCommandBuilder()
                .setName('stop')
                .setDescription('Stop recording and process the audio'),
            execute: this.handleStop.bind(this)
        });

        this.commands.set('last_recording', {
            data: new SlashCommandBuilder()
                .setName('last_recording')
                .setDescription('Get a download link for your most recent recording'),
            execute: this.handleLastRecording.bind(this)
        });

        this.commands.set('transcribe', {
            data: new SlashCommandBuilder()
                .setName('transcribe')
                .setDescription('Manually generate transcript from the last recording (if auto-transcription failed)'),
            execute: this.handleTranscribe.bind(this)
        });

        this.commands.set('ping', {
            data: new SlashCommandBuilder()
                .setName('ping')
                .setDescription('Test if the bot is responsive'),
            execute: this.handlePing.bind(this)
        });

        this.commands.set('summarize', {
            data: new SlashCommandBuilder()
                .setName('summarize')
                .setDescription('Generate a summary of a transcript')
                .addStringOption(option =>
                    option.setName('type')
                        .setDescription('Type of summary to generate')
                        .setRequired(false)
                        .addChoices(
                            { name: 'Brief (Discord chat)', value: 'brief' },
                            { name: 'Detailed (Full summary)', value: 'detailed' },
                            { name: 'Key Points (Bullet list)', value: 'key_points' }
                        ))
                .addStringOption(option =>
                    option.setName('transcript')
                        .setDescription('Transcript title or "latest" for most recent')
                        .setRequired(false)
                        .setAutocomplete(true)),
            execute: this.handleSummarize.bind(this)
        });

        this.commands.set('list', {
            data: new SlashCommandBuilder()
                .setName('list')
                .setDescription('List available recordings and transcripts'),
            execute: this.handleList.bind(this)
        });
    }

    async registerCommands() {
        try {
            logger.info('Started refreshing application (/) commands.');

            const commands = Array.from(this.commands.values()).map(cmd => cmd.data.toJSON());

            const rest = new REST({ version: '10' }).setToken(config.discord.token);

            if (config.discord.guildId) {
                // Register commands for specific guild (faster for development)
                await rest.put(
                    Routes.applicationGuildCommands(this.client.user.id, config.discord.guildId),
                    { body: commands }
                );
                logger.info(`Successfully registered ${commands.length} guild commands.`);
            } else {
                // Register global commands (takes up to 1 hour to propagate)
                await rest.put(
                    Routes.applicationCommands(this.client.user.id),
                    { body: commands }
                );
                logger.info(`Successfully registered ${commands.length} global commands.`);
            }
        } catch (error) {
            logger.error('Error registering commands:', error);
        }
    }

    async handleJoin(interaction) {
        try {
            logger.info(`Join command received from user ${interaction.user.username} in guild ${interaction.guild.id}`);
            logger.info(`Interaction details: id=${interaction.id}, token present=${!!interaction.token}, deferred=${interaction.deferred}, replied=${interaction.replied}`);
            
            // Validate user is in voice channel before deferring
            if (!interaction.member.voice.channel) {
                await interaction.reply({
                    content: '❌ You must be in a voice channel to start recording!',
                    flags: 1 << 6
                });
                return;
            }

            await interaction.deferReply({ flags: 1 << 6 }); // InteractionResponseFlags.Ephemeral
            logger.info(`Join command: Successfully deferred reply`);

            // Immediately update with connecting status
            await interaction.editReply({
                content: `🔄 Connecting to voice channel ${interaction.member.voice.channel.name}...`
            });

            const guildId = interaction.guild.id;
            logger.info(`Join command: Starting recording for guild ${guildId}`);

            const _recordingSession = await voiceRecorder.startRecording(interaction);

            logger.info(`Join command: Recording started successfully for guild ${guildId}`);

            await interaction.editReply({
                content: `🎙️ Started recording in ${interaction.member.voice.channel.name}! Use /stop to finish recording.`
            });

        } catch (error) {
            logger.error('Error in join command:', error);
            try {
                if (interaction.deferred || interaction.replied) {
                    await interaction.editReply({
                        content: `❌ Failed to start recording: ${error.message}`
                    });
                } else {
                    await interaction.reply({
                        content: `❌ Failed to start recording: ${error.message}`,
                        flags: 1 << 6
                    });
                }
            } catch (interactionError) {
                logger.error('Failed to respond to interaction (may have timed out):', interactionError);
            }
        }
    }

    async handleStop(interaction) {
        try {
            await interaction.deferReply({ flags: 1 << 6 }); // Use new ephemeral flag format

            const guildId = interaction.guild.id;
            logger.info(`Stop command: Attempting to stop recording for guild ${guildId}`);

            // Check if recording is active before trying to stop
            if (!voiceRecorder.isRecordingActive(guildId)) {
                logger.warn(`Stop command: No active recording found for guild ${guildId}`);
                logger.info(`Stop command: Active recordings: ${JSON.stringify(voiceRecorder.getAllActiveRecordings())}`);

                await interaction.editReply({
                    content: '❌ No active recording found. Use /join to start a recording first.'
                });
                return;
            }

            // Immediately update with processing status
            await interaction.editReply({
                content: '🔄 Stopping recording and processing audio...'
            });

            const recordingResult = await voiceRecorder.stopRecording(guildId);

            // Check if any audio was captured
            if (!recordingResult.userFiles || recordingResult.userFiles.length === 0) {
                const durationMinutes = Math.round(recordingResult.duration / 60000);

                await interaction.editReply({
                    content: '⚠️ **No audio captured**\n\n' +
                            '📊 **Recording Details:**\n' +
                            `• Duration: ${durationMinutes} minutes\n` +
                            `• Participants: ${recordingResult.participants.length}\n` +
                            '• Audio files: 0\n\n' +
                            '💡 **Possible reasons:**\n' +
                            '• No one spoke during recording\n' +
                            '• Microphones were muted\n' +
                            '• Voice activity detection threshold not met\n' +
                            '• Bot permissions issue\n\n' +
                            'Try recording again and make sure someone speaks clearly.'
                });
                return;
            }

            await interaction.editReply({
                content: '🎙️ **Processing recording...** ⏳'
            });

            // Create mixed audio file from user recordings
            const processedResult = await audioProcessor.createMixedRecording(recordingResult);

            // Generate immediate response with audio download
            const fileName = path.basename(processedResult.outputFile);
            const downloadUrl = this.expressServer.createTemporaryUrl(fileName);
            const durationMinutes = Math.round(recordingResult.duration / 60000);
            const fileSizeMB = Math.round(processedResult.fileSize / 1024 / 1024 * 100) / 100;

            // Check if we have speech segments for transcription
            const canTranscribe = recordingResult.speechSegments && recordingResult.speechSegments.length > 0;

            // Respond immediately with audio download
            let immediateResponse = '🎙️ **Recording Complete!**\n\n';
            immediateResponse += '🔗 **Audio Recording:**\n';
            immediateResponse += `• 🎵 [Download MP3](${downloadUrl})\n\n`;
            immediateResponse += '📊 **Recording Details:**\n';
            immediateResponse += `• Duration: ${durationMinutes} minutes\n`;
            immediateResponse += `• File size: ${fileSizeMB} MB\n`;
            immediateResponse += `• Participants: ${recordingResult.participants.length}\n`;
            immediateResponse += `• Speech segments: ${recordingResult.speechSegments ? recordingResult.speechSegments.length : 0}\n\n`;

            if (canTranscribe) {
                immediateResponse += '⏳ **Transcript:** Processing speech segments...\n';
                immediateResponse += 'I\'ll update this message when transcription is complete!\n\n';
            } else {
                immediateResponse += '⚠️ **Transcript:** No speech segments detected\n\n';
            }

            immediateResponse += '⚠️ *Files expire in 24 hours*';

            await interaction.editReply({ content: immediateResponse });

            // Start async transcription process if we have speech segments
            if (canTranscribe) {
                this.processSegmentTranscriptionAsync(interaction, recordingResult, processedResult, downloadUrl)
                    .catch(error => {
                        logger.error('Async transcription failed:', error);
                    });
            }

            // Clean up temp files
            audioProcessor.cleanupTempFiles(recordingResult.tempDir);


        } catch (error) {
            logger.error('Error in stop command:', error);
            try {
                await interaction.editReply({
                    content: `❌ Failed to stop recording: ${error.message}`
                });
            } catch (interactionError) {
                logger.error('Failed to respond to interaction (may have timed out):', interactionError);
            }
        }
    }

    async handleLastRecording(interaction) {
        try {
            await interaction.deferReply();

            const latestFile = await fileManager.getLatestRecording();

            if (!latestFile) {
                await interaction.editReply({
                    content: '❌ No recordings found. Use /join to start a new recording.'
                });
                return;
            }

            const downloadUrl = this.expressServer.createTemporaryUrl(latestFile.name);
            const created = new Date(latestFile.created);
            const fileSizeMB = Math.round(latestFile.size / 1024 / 1024 * 100) / 100;

            await interaction.editReply({
                content: '📁 **Latest Recording**\n\n' +
                        `• File: ${latestFile.name}\n` +
                        `• Created: ${created.toLocaleString()}\n` +
                        `• Size: ${fileSizeMB} MB\n\n` +
                        `📥 **Download:** ${downloadUrl}\n\n` +
                        '⚠️ Files are automatically deleted after 24 hours.'
            });

        } catch (error) {
            logger.error('Error in last_recording command:', error);
            await interaction.editReply({
                content: `❌ Failed to get last recording: ${error.message}`
            });
        }
    }

    async handleTranscribe(interaction) {
        try {
            await interaction.deferReply();

            const guildId = interaction.guild.id;

            // Check if there's an active recording
            if (voiceRecorder.isRecordingActive(guildId)) {
                await interaction.editReply({
                    content: '⚠️ Recording is still in progress. Use /stop first to finish recording, then try /transcribe.'
                });
                return;
            }

            // Find the most recent recording session with speech segments
            const latestFile = await fileManager.getLatestRecording();
            if (!latestFile) {
                await interaction.editReply({
                    content: '❌ No recordings found. Use /join to start a recording first.'
                });
                return;
            }

            // Look for speech segments metadata file
            const fs = require('fs');
            const metadataPath = latestFile.path.replace('.mp3', '_segments.json');

            if (!fs.existsSync(metadataPath)) {
                // Fallback: try to find continuous user recording files
                const tempDirPath = latestFile.path.replace('.mp3', '').replace('recordings', 'temp');

                if (fs.existsSync(tempDirPath)) {
                    const userFiles = fs.readdirSync(tempDirPath)
                        .filter(file => file.startsWith('user_') && file.endsWith('.pcm'))
                        .map(filename => {
                            const filePath = path.join(tempDirPath, filename);
                            const stats = fs.statSync(filePath);

                            // Skip empty files
                            if (stats.size < 1000) {
                                return null;
                            }

                            // Parse user info from filename: user_userId_username.pcm
                            const parts = filename.replace('.pcm', '').split('_');
                            const userId = parts[1];
                            const username = parts.slice(2).join('_'); // Handle usernames with underscores

                            return {
                                segmentId: `continuous_${userId}`,
                                userId,
                                username,
                                displayName: username,
                                startTimestamp: Date.now() - 60000, // Estimate start time
                                endTimestamp: Date.now(),
                                duration: 60000, // Estimate duration
                                filename: filePath
                            };
                        })
                        .filter(Boolean); // Remove null entries

                    if (userFiles.length > 0) {
                        await interaction.editReply({
                            content: `🤖 Found continuous recording files. Starting transcription of ${userFiles.length} user recordings...\n\n⏳ This may take a few moments.`
                        });

                        // Transcribe the continuous files
                        const transcriptionResults = await transcriptionService.transcribeSegments(userFiles);

                        // Format the transcript
                        const transcript = transcriptionService.formatTranscript(transcriptionResults);

                        // Save transcript to file
                        const transcriptFilename = `transcript_${Date.now()}.md`;
                        const transcriptPath = path.join(require('../config').paths.recordings, transcriptFilename);
                        fs.writeFileSync(transcriptPath, transcript.text);

                        // Generate title for the transcript
                        let generatedTitle = null;
                        try {
                            const transcriptId = transcriptFilename.replace('transcript_', '').replace('.md', '');
                            const titleResult = await titleGenerationService.generateTitle(transcript.text);
                            await titleGenerationService.saveTitle(titleResult, transcriptId);
                            generatedTitle = titleResult;
                            logger.info(`Generated title for manual transcription: "${titleResult.title}"`);
                        } catch (titleError) {
                            logger.error('Failed to generate title for manual transcription:', titleError);
                            // Generate fallback title
                            try {
                                const transcriptId = transcriptFilename.replace('transcript_', '').replace('.md', '');
                                const fallbackTitle = titleGenerationService.generateFallbackTitle(transcriptId);
                                await titleGenerationService.saveTitle(fallbackTitle, transcriptId);
                                generatedTitle = fallbackTitle;
                            } catch (fallbackError) {
                                logger.error('Failed to generate fallback title:', fallbackError);
                            }
                        }

                        // Create download link and web viewer link
                        const downloadUrl = this.expressServer.createTemporaryUrl(transcriptFilename);
                        const webViewerUrl = this.createTranscriptViewerLink(transcriptFilename);

                        let responseContent = '✅ **Transcription completed!**\n\n' +
                                '📊 **Results:**\n' +
                                `• Total segments: ${transcript.metadata.totalSegments}\n` +
                                `• Transcribed segments: ${transcript.metadata.transcribedSegments}\n` +
                                `• Participants: ${transcript.metadata.participants.join(', ')}\n` +
                                `• Duration: ${transcript.metadata.totalDuration}\n\n` +
                                `📄 **Transcript:** [View Online](${webViewerUrl}) | [Download](${downloadUrl})\n`;

                        if (generatedTitle) {
                            responseContent += `🏷️ **Title:** "${generatedTitle.title}"\n`;
                        }

                        responseContent += '\n⚠️ Transcript files are automatically deleted after 24 hours.\n\n' +
                                '💡 *Note: Used continuous recording mode (speech segmentation not working)*';

                        await interaction.editReply({
                            content: responseContent
                        });
                        return;
                    }
                }

                await interaction.editReply({
                    content: '❌ No speech segments or user recording files found. This recording may not have any audio content.'
                });
                return;
            }

            // Load speech segments metadata
            let speechSegments;
            try {
                const metadataContent = fs.readFileSync(metadataPath, 'utf8');
                speechSegments = JSON.parse(metadataContent);
            } catch (error) {
                logger.error('Failed to parse speech segments metadata:', error);
                await interaction.editReply({
                    content: '❌ Failed to load speech segments metadata. The file may be corrupted.'
                });
                return;
            }

            if (!speechSegments || speechSegments.length === 0) {
                await interaction.editReply({
                    content: '❌ No speech segments found in the recording. Make sure people spoke during the recording.'
                });
                return;
            }

            // Verify segment files still exist
            const validSegments = speechSegments.filter(segment => fs.existsSync(segment.filename));
            if (validSegments.length === 0) {
                await interaction.editReply({
                    content: '❌ Speech segment files not found. They may have been cleaned up or moved.'
                });
                return;
            }

            await interaction.editReply({
                content: `🤖 Starting transcription of ${validSegments.length} speech segments...\n\n⏳ This may take a few moments depending on the amount of audio.`
            });

            // Transcribe the segments
            const transcriptionResults = await transcriptionService.transcribeSegments(validSegments);

            // Format the transcript
            const transcript = transcriptionService.formatTranscript(transcriptionResults);

            // Save transcript to file
            const transcriptFilename = `transcript_${Date.now()}.md`;
            const transcriptPath = require('path').join(require('../config').paths.recordings, transcriptFilename);
            fs.writeFileSync(transcriptPath, transcript.text);

            // Generate title for the transcript
            let generatedTitle = null;
            try {
                const transcriptId = transcriptFilename.replace('transcript_', '').replace('.md', '');
                const titleResult = await titleGenerationService.generateTitle(transcript.text);
                await titleGenerationService.saveTitle(titleResult, transcriptId);
                generatedTitle = titleResult;
                logger.info(`Generated title for manual transcription: "${titleResult.title}"`);
            } catch (titleError) {
                logger.error('Failed to generate title for manual transcription:', titleError);
                // Generate fallback title
                try {
                    const transcriptId = transcriptFilename.replace('transcript_', '').replace('.md', '');
                    const fallbackTitle = titleGenerationService.generateFallbackTitle(transcriptId);
                    await titleGenerationService.saveTitle(fallbackTitle, transcriptId);
                    generatedTitle = fallbackTitle;
                } catch (fallbackError) {
                    logger.error('Failed to generate fallback title:', fallbackError);
                }
            }

            // Create download link and web viewer link
            const downloadUrl = this.expressServer.createTemporaryUrl(transcriptFilename);
            const webViewerUrl = this.createTranscriptViewerLink(transcriptFilename);

            let responseContent = '✅ **Transcription completed!**\n\n' +
                    '📊 **Results:**\n' +
                    `• Total segments: ${transcript.metadata.totalSegments}\n` +
                    `• Transcribed segments: ${transcript.metadata.transcribedSegments}\n` +
                    `• Participants: ${transcript.metadata.participants.join(', ')}\n` +
                    `• Duration: ${transcript.metadata.totalDuration}\n\n` +
                    `📄 **Transcript:** [View Online](${webViewerUrl}) | [Download](${downloadUrl})\n`;

            if (generatedTitle) {
                responseContent += `🏷️ **Title:** "${generatedTitle.title}"\n`;
            }

            responseContent += '\n⚠️ Transcript files are automatically deleted after 24 hours.';

            await interaction.editReply({
                content: responseContent
            });

        } catch (error) {
            logger.error('Error in transcribe command:', error);
            await interaction.editReply({
                content: `❌ Failed to generate transcript: ${error.message}`
            });
        }
    }

    async handlePing(interaction) {
        await interaction.reply({
            content: `🏓 Pong! Bot latency: ${this.client.ws.ping}ms`,
            flags: 1 << 6 // InteractionResponseFlags.Ephemeral
        });
    }

    async handleList(interaction) {
        try {
            await interaction.deferReply();

            const fs = require('fs');

            // Get all recordings
            const recordings = [];
            const transcripts = [];

            if (fs.existsSync(config.paths.recordings)) {
                const files = fs.readdirSync(config.paths.recordings);

                for (const file of files) {
                    const filePath = path.join(config.paths.recordings, file);
                    const stats = fs.statSync(filePath);

                    if (file.endsWith('.mp3')) {
                        // Extract recording ID from filename
                        const recordingId = file.replace('.mp3', '');
                        recordings.push({
                            id: recordingId,
                            name: file,
                            size: Math.round(stats.size / 1024 / 1024 * 100) / 100, // MB
                            created: stats.ctime
                        });
                    } else if (file.startsWith('transcript_') && file.endsWith('.md')) {
                        // Extract transcript ID from filename
                        const transcriptId = file.replace('transcript_', '').replace('.md', '');

                        // Try to get title for this transcript (non-blocking)
                        let title = null;
                        try {
                            const titleData = titleGenerationService.getTitle(transcriptId);
                            title = titleData ? titleData.title : null;
                        } catch (_error) {
                            // No title found, use null
                        }

                        transcripts.push({
                            id: transcriptId,
                            name: file,
                            title: title,
                            created: stats.ctime
                        });
                    }
                }
            }

            // Sort by creation date (newest first)
            recordings.sort((a, b) => b.created - a.created);
            transcripts.sort((a, b) => b.created - a.created);

            let response = '📁 **Available Recordings & Transcripts**\n\n';

            if (recordings.length === 0 && transcripts.length === 0) {
                response += '❌ No recordings or transcripts found.\n\n';
                response += '💡 Use `/join` to start a recording in a voice channel.';
            } else {
                if (recordings.length > 0) {
                    response += '🎵 **Recordings:**\n';
                    const recentRecordings = recordings.slice(0, 3); // Show max 3
                    for (const recording of recentRecordings) {
                        const date = recording.created.toLocaleDateString();
                        response += `• \`${recording.id}\` - ${recording.size}MB - ${date}\n`;
                    }
                    if (recordings.length > 3) {
                        response += `... and ${recordings.length - 3} more\n`;
                    }
                    response += '\n';
                }

                if (transcripts.length > 0) {
                    response += '📄 **Transcripts:**\n';
                    const recentTranscripts = transcripts.slice(0, 5); // Show max 5
                    for (const transcript of recentTranscripts) {
                        const date = transcript.created.toLocaleDateString();
                        const webViewerUrl = this.createTranscriptViewerLink(`transcript_${transcript.id}.md`);

                        if (transcript.title) {
                            const shortTitle = transcript.title.length > 40 ? transcript.title.substring(0, 37) + '...' : transcript.title;
                            response += `• **${shortTitle}** - ${date} - [View](${webViewerUrl})\n`;
                        } else {
                            response += `• \`${transcript.id}\` - ${date} - [View](${webViewerUrl})\n`;
                        }
                    }
                    if (transcripts.length > 5) {
                        response += `... and ${transcripts.length - 5} more\n`;
                    }
                    response += '\n';
                }

                response += '💡 Use `/summarize` to generate summaries from transcripts.';
            }

            await interaction.editReply({
                content: response
            });

        } catch (error) {
            logger.error('Error in list command:', error);
            await interaction.editReply({
                content: `❌ Failed to list recordings: ${error.message}`
            });
        }
    }

    async handleSummarize(interaction) {
        try {
            logger.info(`Summarize command started - type: ${interaction.options.getString('type')}, transcript: ${interaction.options.getString('transcript')}`);
            await interaction.deferReply();

            const summaryType = interaction.options.getString('type') || 'detailed';
            const transcriptInput = interaction.options.getString('transcript') || 'latest';
            logger.info(`Processing summary request - type: ${summaryType}, transcript: ${transcriptInput}`);

            // Validate summary type
            if (!summarizationService.validateSummaryType(summaryType)) {
                await interaction.editReply({
                    content: '❌ Invalid summary type. Valid types: brief, detailed, key_points'
                });
                return;
            }

            // Find the transcript file
            let transcriptPath = null;
            let transcriptId = null;

            if (transcriptInput === 'latest') {
                // Find latest transcript
                const fs = require('fs');
                const files = fs.readdirSync(config.paths.recordings)
                    .filter(file => file.startsWith('transcript_') && file.endsWith('.md'))
                    .map(file => ({
                        name: file,
                        path: path.join(config.paths.recordings, file),
                        created: fs.statSync(path.join(config.paths.recordings, file)).ctime
                    }))
                    .sort((a, b) => b.created - a.created);

                if (files.length === 0) {
                    await interaction.editReply({
                        content: '❌ No transcript files found. Generate a transcript first using /transcribe or /stop.'
                    });
                    return;
                }

                transcriptPath = files[0].path;
                transcriptId = files[0].name.replace('transcript_', '').replace('.md', '');
            } else {
                // Use specific transcript ID
                transcriptId = transcriptInput;

                // Validate transcript ID to prevent path traversal
                if (!/^[a-zA-Z0-9_-]+$/.test(transcriptId)) {
                    await interaction.editReply({
                        content: '❌ Invalid transcript ID format. Use alphanumeric characters, underscores, and hyphens only.'
                    });
                    return;
                }

                transcriptPath = path.join(config.paths.recordings, `transcript_${transcriptId}.md`);

                if (!require('fs').existsSync(transcriptPath)) {
                    await interaction.editReply({
                        content: `❌ Transcript not found: ${transcriptId}. Use "latest" or check your transcript ID.`
                    });
                    return;
                }
            }

            // Check if summary already exists
            if (summarizationService.summaryExists(transcriptId, summaryType)) {
                const existingSummary = await summarizationService.getSummary(transcriptId, summaryType);

                // Extract summary content (remove metadata)
                if (!existingSummary.content || typeof existingSummary.content !== 'string') {
                    logger.error('Invalid summary content received:', typeof existingSummary.content);
                    throw new Error('Invalid summary content format');
                }

                const summaryLines = existingSummary.content.split('\n');
                if (!Array.isArray(summaryLines)) {
                    logger.error('Failed to split summary content into lines');
                    throw new Error('Failed to parse summary content');
                }

                const summaryStartIndex = summaryLines.findIndex(line => line.trim() === '---') + 1;
                const summaryEndIndex = summaryLines.findLastIndex(line => line.trim() === '---');
                const summaryText = summaryLines.slice(summaryStartIndex, summaryEndIndex).join('\n').trim();

                // For brief summaries, post in Discord if short enough
                if (summaryType === 'brief' && summaryText.length <= 1800) {
                    await interaction.editReply({
                        content: `📝 **${summaryType.charAt(0).toUpperCase() + summaryType.slice(1)} Summary** (cached)\n\n${summaryText}`
                    });
                } else {
                    // Create download link and web viewer link
                    const downloadUrl = this.expressServer.createTemporaryUrl(path.basename(existingSummary.path));
                    const webViewerUrl = `${config.express.baseUrl}/summary?id=${transcriptId}&type=${summaryType}`;

                    await interaction.editReply({
                        content: `📝 **${summaryType.charAt(0).toUpperCase() + summaryType.slice(1)} Summary** (cached)\n\n` +
                                `📄 **View:** [Online](${webViewerUrl}) | [Download](${downloadUrl})\n\n` +
                                '⚠️ Summary files are automatically deleted after 24 hours.'
                    });
                }
                return;
            }

            await interaction.editReply({
                content: `🤖 Generating ${summaryType} summary...\n\n⏳ This may take a few moments.`
            });

            // Generate new summary with timeout
            const summaryResult = await Promise.race([
                summarizationService.summarizeTranscript(transcriptPath, summaryType),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Summarization timed out')), 45000))
            ]);

            // Save summary to file
            const savedSummary = await summarizationService.saveSummary(summaryResult, transcriptId, summaryType);

            // For brief summaries, post in Discord if short enough
            if (summaryType === 'brief' && summaryResult.summary.length <= 1800) {
                await interaction.editReply({
                    content: `📝 **${summaryType.charAt(0).toUpperCase() + summaryType.slice(1)} Summary**\n\n${summaryResult.summary}\n\n` +
                            `📊 **Stats:** ${summaryResult.metadata.compressionRatio}% of original length`
                });
            } else {
                // Create download link and web viewer link
                const downloadUrl = this.expressServer.createTemporaryUrl(savedSummary.fileName);
                const webViewerUrl = `${config.express.baseUrl}/summary?id=${transcriptId}&type=${summaryType}`;

                await interaction.editReply({
                    content: `✅ **${summaryType.charAt(0).toUpperCase() + summaryType.slice(1)} Summary Generated!**\n\n` +
                            '📊 **Stats:**\n' +
                            `• Original length: ${summaryResult.metadata.originalLength} characters\n` +
                            `• Summary length: ${summaryResult.metadata.summaryLength} characters\n` +
                            `• Compression: ${100 - summaryResult.metadata.compressionRatio}% reduction\n\n` +
                            `📄 **View:** [Online](${webViewerUrl}) | [Download](${downloadUrl})\n\n` +
                            '⚠️ Summary files are automatically deleted after 24 hours.'
                });
            }

        } catch (error) {
            logger.error('Error in summarize command:', error);

            // Try to respond with error, but don't fail if interaction is already expired
            try {
                await interaction.editReply({
                    content: `❌ Failed to generate summary: ${error.message}`
                });
            } catch (interactionError) {
                logger.error('Failed to edit reply with error message:', interactionError);
            }
        }
    }

    async handleInteraction(interaction) {
        if (!interaction.isChatInputCommand()) {
            return;
        }

        const command = this.commands.get(interaction.commandName);
        if (!command) {
            logger.warn(`Unknown command: ${interaction.commandName}`);
            return;
        }

        try {
            await command.execute(interaction);
        } catch (error) {
            logger.error(`Error executing command ${interaction.commandName}:`, error);

            const response = { content: '❌ An error occurred while executing this command.', flags: 1 << 6 }; // InteractionResponseFlags.Ephemeral

            try {
                if (interaction.deferred || interaction.replied) {
                    await interaction.editReply(response);
                } else {
                    await interaction.reply(response);
                }
            } catch (interactionError) {
                logger.error('Failed to respond to interaction (may have timed out):', interactionError);
            }
        }
    }

    async postRecordingCompletionMessage(interaction, recordingData) {
        try {
            // Find the text channel associated with the voice channel
            const voiceChannel = interaction.member?.voice?.channel;
            if (!voiceChannel) {
                logger.warn('No voice channel found for recording completion message');
                return;
            }

            // Try to find a text channel with similar name or the general channel
            const guild = interaction.guild;
            let textChannel = null;

            // First, try to find a text channel with the same name as voice channel
            textChannel = guild.channels.cache.find(channel =>
                channel.type === 0 && // TEXT channel type
                channel.name.toLowerCase() === voiceChannel.name.toLowerCase()
            );

            // If not found, try to find "general" or similar
            if (!textChannel) {
                textChannel = guild.channels.cache.find(channel =>
                    channel.type === 0 &&
                    (channel.name.includes('general') || channel.name.includes('chat') || channel.name.includes('main'))
                );
            }

            // If still not found, use the first available text channel
            if (!textChannel) {
                textChannel = guild.channels.cache.find(channel => channel.type === 0);
            }

            if (!textChannel) {
                logger.warn('No suitable text channel found for recording completion message');
                return;
            }

            // Create the public completion message
            const { recordingId, transcriptId, title, briefSummary, _transcriptPath, _recordingPath, transcriptStats } = recordingData;

            // Generate URLs
            const recordingUrl = this.expressServer.createTemporaryUrl(`${recordingId}.mp3`);
            const transcriptUrl = this.expressServer.createTemporaryUrl(`transcript_${transcriptId}.md`);
            const webViewerUrl = this.createTranscriptViewerLink(`transcript_${transcriptId}.md`);
            const detailedSummaryUrl = `${config.express.baseUrl}/summary?id=${transcriptId}&type=detailed`;

            // Build the message
            let message = '🎙️ **Recording Complete!**\n\n';

            if (title) {
                message += `📝 **"${title}"**\n\n`;
            }

            if (briefSummary) {
                // Truncate summary if too long for Discord
                const maxSummaryLength = 800;
                const displaySummary = briefSummary.length > maxSummaryLength
                    ? briefSummary.substring(0, maxSummaryLength) + '...'
                    : briefSummary;
                message += `📋 **Summary:**\n${displaySummary}\n\n`;
            }

            message += '🔗 **Links:**\n';
            message += `• 🎵 [Audio Recording](${recordingUrl})\n`;
            message += `• 📄 [Transcript](${webViewerUrl}) | [Download](${transcriptUrl})\n`;
            message += `• 📊 [Detailed Summary](${detailedSummaryUrl})\n\n`;

            if (transcriptStats) {
                message += `📈 **Stats:** ${transcriptStats.participants.join(', ')} • ${transcriptStats.transcribedSegments}/${transcriptStats.totalSegments} segments\n\n`;
            }

            message += '⚠️ *Files expire in 24 hours*';

            // Post the message to the text channel
            await textChannel.send(message);
            logger.info(`Posted recording completion message to #${textChannel.name}`);

        } catch (error) {
            logger.error('Failed to post recording completion message:', error);
            // Don't throw - this is not critical to the recording process
        }
    }

    async handleSummarizeAutocomplete(interaction) {
        try {
            const focusedValue = interaction.options.getFocused();
            const fs = require('fs');

            if (!fs.existsSync(config.paths.recordings)) {
                await interaction.respond([]);
                return;
            }

            // Get available transcripts with titles
            const files = fs.readdirSync(config.paths.recordings)
                .filter(file => file.startsWith('transcript_') && file.endsWith('.md'))
                .map(file => {
                    const transcriptId = file.replace('transcript_', '').replace('.md', '');
                    const filePath = path.join(config.paths.recordings, file);
                    const stats = fs.statSync(filePath);

                    return {
                        id: transcriptId,
                        file: file,
                        created: stats.ctime
                    };
                })
                .sort((a, b) => b.created - a.created);

            // Get titles for these transcripts
            const choices = [];
            choices.push({ name: 'Latest', value: 'latest' });

            for (const file of files.slice(0, 24)) { // Discord limit is 25 choices
                try {
                    const titleData = titleGenerationService.getTitle(file.id);
                    const title = titleData ? titleData.title : null;

                    if (title) {
                        const name = title.length > 90 ? title.substring(0, 87) + '...' : title;
                        choices.push({ name: name, value: file.id });
                    } else {
                        // Fallback to ID if no title
                        const date = file.created.toLocaleDateString();
                        choices.push({ name: `${file.id} (${date})`, value: file.id });
                    }
                } catch (_error) {
                    // If title retrieval fails, use ID
                    const date = file.created.toLocaleDateString();
                    choices.push({ name: `${file.id} (${date})`, value: file.id });
                }
            }

            // Filter choices based on focused value
            const filtered = choices.filter(choice =>
                choice.name.toLowerCase().includes(focusedValue.toLowerCase())
            );

            await interaction.respond(filtered);
        } catch (error) {
            logger.error('Error in summarize autocomplete:', error);
            await interaction.respond([]);
        }
    }

    async processSegmentTranscriptionAsync(interaction, recordingResult, processedResult, downloadUrl) {
        let transcriptUrl = null;
        let transcriptStats = null;
        let generatedTitle = null;
        let briefSummary = null;

        try {
            logger.info(`Starting segment-based transcription for ${recordingResult.speechSegments.length} speech segments`);

            // Transcribe speech segments using the new approach
            const transcriptionResults = await transcriptionService.transcribeSpeechSegments(
                recordingResult.speechSegments,
                recordingResult.userFiles
            );
            const transcript = transcriptionService.formatTranscript(transcriptionResults);

            // Save transcript to file
            const recordingId = path.basename(processedResult.outputFile, '.mp3');
            const transcriptFilename = `transcript_${recordingId}.md`;
            const transcriptPath = path.join(path.dirname(processedResult.outputFile), transcriptFilename);
            require('fs').writeFileSync(transcriptPath, transcript.text);

            // Create download link for transcript
            transcriptUrl = this.expressServer.createTemporaryUrl(transcriptFilename);
            transcriptStats = transcript.metadata;

            logger.info(`Generated transcript with ${transcriptStats.transcribedSegments}/${transcriptStats.totalSegments} segments`);

            // Generate title and brief summary from transcript content
            try {
                // Use the recordingId we already calculated

                // Generate title
                const titleResult = await titleGenerationService.generateTitle(transcript.text);
                await titleGenerationService.saveTitle(titleResult, recordingId);
                generatedTitle = titleResult;
                logger.info(`Generated title: "${titleResult.title}" (slug: ${titleResult.slug})`);

                // Generate brief summary
                const summaryResult = await summarizationService.summarizeTranscript(transcriptPath, 'brief');
                briefSummary = summaryResult.summary;
                logger.info(`Generated brief summary for transcript ${recordingId}`);

            } catch (titleError) {
                logger.error('Failed to generate title or summary:', titleError);
                // Generate fallback title
                try {
                    const fallbackTitle = titleGenerationService.generateFallbackTitle(recordingId);
                    await titleGenerationService.saveTitle(fallbackTitle, recordingId);
                    generatedTitle = fallbackTitle;
                    logger.info(`Used fallback title: "${fallbackTitle.title}"`);
                } catch (fallbackError) {
                    logger.error('Failed to generate fallback title:', fallbackError);
                }
            }

            // Build updated response with transcript results
            const durationMinutes = Math.round(recordingResult.duration / 60000);
            const fileSizeMB = Math.round(processedResult.fileSize / 1024 / 1024 * 100) / 100;

            let updatedResponse = '🎙️ **Recording Complete!**\n\n';

            // Add title if available
            if (generatedTitle) {
                updatedResponse += `📝 **"${generatedTitle.title}"**\n\n`;
            }

            // Add summary if available
            if (briefSummary) {
                const maxSummaryLength = 800;
                const displaySummary = briefSummary.length > maxSummaryLength
                    ? briefSummary.substring(0, maxSummaryLength) + '...'
                    : briefSummary;
                updatedResponse += `📋 **Summary:**\n${displaySummary}\n\n`;
            }

            updatedResponse += '🔗 **Links:**\n';
            updatedResponse += `• 🎵 [Audio Recording](${downloadUrl})\n`;

            // Add transcript info
            if (transcriptUrl && transcriptStats) {
                const recordingId = path.basename(recordingResult.outputFile, '.mp3');
                const webViewerUrl = this.createTranscriptViewerLink(`transcript_${recordingId}.md`);
                const detailedSummaryUrl = `${config.express.baseUrl}/summary?id=${recordingId}&type=detailed`;

                updatedResponse += `• 📄 [Transcript](${webViewerUrl}) | [Download](${transcriptUrl})\n`;
                updatedResponse += `• 📊 [Detailed Summary](${detailedSummaryUrl})\n\n`;

                updatedResponse += `📈 **Stats:** ${transcriptStats.participants.join(', ')} • ${transcriptStats.transcribedSegments}/${transcriptStats.totalSegments} segments\n\n`;
            }

            updatedResponse += '📊 **Recording Details:**\n';
            updatedResponse += `• Duration: ${durationMinutes} minutes\n`;
            updatedResponse += `• File size: ${fileSizeMB} MB\n`;
            updatedResponse += `• Participants: ${recordingResult.participants.length}\n`;
            updatedResponse += `• Speech segments: ${recordingResult.speechSegments.length}\n\n`;
            updatedResponse += '⚠️ *Files expire in 24 hours*';

            // Update the original interaction with completed transcript
            await interaction.editReply({ content: updatedResponse });

        } catch (error) {
            logger.error('Failed to auto-generate transcript:', error);

            // Update with error message
            const durationMinutes = Math.round(recordingResult.duration / 60000);
            const fileSizeMB = Math.round(processedResult.fileSize / 1024 / 1024 * 100) / 100;

            let errorResponse = '🎙️ **Recording Complete!**\n\n';
            errorResponse += '🔗 **Audio Recording:**\n';
            errorResponse += `• 🎵 [Download MP3](${downloadUrl})\n\n`;
            errorResponse += '📊 **Recording Details:**\n';
            errorResponse += `• Duration: ${durationMinutes} minutes\n`;
            errorResponse += `• File size: ${fileSizeMB} MB\n`;
            errorResponse += `• Participants: ${recordingResult.participants.length}\n`;
            errorResponse += `• Speech segments: ${recordingResult.speechSegments ? recordingResult.speechSegments.length : 0}\n\n`;
            errorResponse += '⚠️ **Transcript:** Generation failed, but you can try /transcribe later\n\n';
            errorResponse += '⚠️ *Files expire in 24 hours*';

            await interaction.editReply({ content: errorResponse });
        }
    }
}

module.exports = CommandHandler;
