const { REST, Routes, SlashCommandBuilder } = require('discord.js');
const path = require('path');
const config = require('../config');
const logger = require('../utils/logger');
const voiceRecorder = require('../audio/VoiceRecorder');
const audioProcessor = require('../audio/AudioProcessor');
const fileManager = require('../utils/fileManager');
const transcriptionService = require('../services/TranscriptionService');
const { COMMANDS, ERROR_MESSAGES, SUCCESS_MESSAGES } = require('../constants');

class CommandHandler {
    constructor(client, expressServer) {
        this.client = client;
        this.expressServer = expressServer;
        this.commands = new Map();
        this.setupCommands();
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
            await interaction.deferReply({ ephemeral: true });

            const recordingSession = await voiceRecorder.startRecording(interaction);
            
            await interaction.editReply({
                content: `🎙️ Started recording in ${interaction.member.voice.channel.name}! Use /stop to finish recording.`
            });

        } catch (error) {
            logger.error('Error in join command:', error);
            await interaction.editReply({
                content: `❌ Failed to start recording: ${error.message}`
            });
        }
    }

    async handleStop(interaction) {
        try {
            await interaction.deferReply({ ephemeral: true });

            const guildId = interaction.guild.id;
            const recordingResult = await voiceRecorder.stopRecording(guildId);
            
            // Check if any audio was captured
            if (recordingResult.filesCreated === 0) {
                const durationMinutes = Math.round(recordingResult.duration / 60000);
                
                await interaction.editReply({
                    content: `⚠️ **No audio captured**\n\n` +
                            `📊 **Recording Details:**\n` +
                            `• Duration: ${durationMinutes} minutes\n` +
                            `• Participants: ${recordingResult.participants.length}\n` +
                            `• Audio segments: 0\n\n` +
                            `💡 **Possible reasons:**\n` +
                            `• No one spoke during recording\n` +
                            `• Microphones were muted\n` +
                            `• Voice activity detection threshold not met\n` +
                            `• Bot permissions issue\n\n` +
                            `Try recording again and make sure someone speaks clearly.`
                });
                return;
            }

            await interaction.editReply({
                content: SUCCESS_MESSAGES.PROCESSING_AUDIO
            });

            // Process the recording segments (but don't clean up temp files yet if we have speech segments)
            const shouldKeepTempFiles = recordingResult.speechSegments && recordingResult.speechSegments.length > 0;
            const processedResult = await audioProcessor.processRecording(
                recordingResult.tempDir,
                recordingResult.outputFile,
                !shouldKeepTempFiles // Only cleanup if no speech segments to transcribe
            );

            // Auto-generate transcript if speech segments were detected
            let transcriptUrl = null;
            let transcriptStats = null;
            
            if (recordingResult.speechSegments && recordingResult.speechSegments.length > 0) {
                // Save speech segments metadata for future reference
                const metadataPath = path.join(path.dirname(recordingResult.outputFile), `${path.basename(recordingResult.outputFile, '.mp3')}_segments.json`);
                require('fs').writeFileSync(metadataPath, JSON.stringify(recordingResult.speechSegments, null, 2));
                logger.info(`Saved ${recordingResult.speechSegments.length} speech segments metadata to ${metadataPath}`);

                // Update user about transcription starting
                await interaction.editReply({
                    content: `${SUCCESS_MESSAGES.PROCESSING_AUDIO} ${SUCCESS_MESSAGES.GENERATING_TRANSCRIPT}`
                });

                try {
                    // Generate transcript automatically
                    const transcriptionResults = await transcriptionService.transcribeSegments(recordingResult.speechSegments);
                    const transcript = transcriptionService.formatTranscript(transcriptionResults);
                    
                    // Save transcript to file
                    const transcriptFilename = `transcript_${path.basename(recordingResult.outputFile, '.mp3')}.md`;
                    const transcriptPath = path.join(path.dirname(recordingResult.outputFile), transcriptFilename);
                    require('fs').writeFileSync(transcriptPath, transcript.text);

                    // Create download link for transcript
                    transcriptUrl = this.expressServer.createTemporaryUrl(transcriptFilename);
                    transcriptStats = transcript.metadata;
                    
                    logger.info(`Auto-generated transcript with ${transcriptStats.transcribedSegments}/${transcriptStats.totalSegments} segments`);
                    
                } catch (error) {
                    logger.error('Failed to auto-generate transcript:', error);
                    // Continue without transcript - don't fail the whole recording
                } finally {
                    // Clean up temp directory after transcription is complete
                    if (shouldKeepTempFiles) {
                        try {
                            const fs = require('fs');
                            if (fs.existsSync(recordingResult.tempDir)) {
                                fs.rmSync(recordingResult.tempDir, { recursive: true, force: true });
                                logger.info(`Cleaned up temp directory after transcription: ${recordingResult.tempDir}`);
                            }
                        } catch (cleanupError) {
                            logger.error('Failed to clean up temp directory after transcription:', cleanupError);
                        }
                    }
                }
            }

            // Generate temporary download link for audio
            const fileName = path.basename(processedResult.outputFile);
            const downloadUrl = this.expressServer.createTemporaryUrl(fileName);
            
            const durationMinutes = Math.round(recordingResult.duration / 60000);
            const fileSizeMB = Math.round(processedResult.fileSize / 1024 / 1024 * 100) / 100;

            // Build response message
            let responseContent = `✅ Recording completed!\n\n` +
                    `📊 **Recording Details:**\n` +
                    `• Duration: ${durationMinutes} minutes\n` +
                    `• File size: ${fileSizeMB} MB\n` +
                    `• Participants: ${recordingResult.participants.length}\n` +
                    `• Audio segments: ${processedResult.segmentCount}\n\n` +
                    `🎵 **Audio Download:** ${downloadUrl}\n`;

            // Add transcript info if available
            if (transcriptUrl && transcriptStats) {
                responseContent += `📄 **Transcript Download:** ${transcriptUrl}\n` +
                    `• Transcribed segments: ${transcriptStats.transcribedSegments}/${transcriptStats.totalSegments}\n` +
                    `• Participants: ${transcriptStats.participants.join(', ')}\n`;
            } else if (recordingResult.speechSegments && recordingResult.speechSegments.length > 0) {
                responseContent += `⚠️ **Transcript:** Generation failed, but you can try /transcribe later\n`;
            }

            responseContent += `\n⚠️ Files are automatically deleted after 24 hours.`;

            await interaction.editReply({
                content: responseContent
            });

        } catch (error) {
            logger.error('Error in stop command:', error);
            await interaction.editReply({
                content: `❌ Failed to stop recording: ${error.message}`
            });
        }
    }

    async handleLastRecording(interaction) {
        try {
            await interaction.deferReply({ ephemeral: true });

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
                content: `📁 **Latest Recording**\n\n` +
                        `• File: ${latestFile.name}\n` +
                        `• Created: ${created.toLocaleString()}\n` +
                        `• Size: ${fileSizeMB} MB\n\n` +
                        `📥 **Download:** ${downloadUrl}\n\n` +
                        `⚠️ Files are automatically deleted after 24 hours.`
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
            await interaction.deferReply({ ephemeral: true });

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
                            if (stats.size < 1000) return null;
                            
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

                        // Create download link
                        const downloadUrl = this.expressServer.createTemporaryUrl(transcriptFilename);

                        await interaction.editReply({
                            content: `✅ **Transcription completed!**\n\n` +
                                    `📊 **Results:**\n` +
                                    `• Total segments: ${transcript.metadata.totalSegments}\n` +
                                    `• Transcribed segments: ${transcript.metadata.transcribedSegments}\n` +
                                    `• Participants: ${transcript.metadata.participants.join(', ')}\n` +
                                    `• Duration: ${transcript.metadata.totalDuration}\n\n` +
                                    `📄 **Download transcript:** ${downloadUrl}\n\n` +
                                    `⚠️ Transcript files are automatically deleted after 24 hours.\n\n` +
                                    `💡 *Note: Used continuous recording mode (speech segmentation not working)*`
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

            // Create download link
            const downloadUrl = this.expressServer.createTemporaryUrl(transcriptFilename);

            await interaction.editReply({
                content: `✅ **Transcription completed!**\n\n` +
                        `📊 **Results:**\n` +
                        `• Total segments: ${transcript.metadata.totalSegments}\n` +
                        `• Transcribed segments: ${transcript.metadata.transcribedSegments}\n` +
                        `• Participants: ${transcript.metadata.participants.join(', ')}\n` +
                        `• Duration: ${transcript.metadata.totalDuration}\n\n` +
                        `📄 **Download transcript:** ${downloadUrl}\n\n` +
                        `⚠️ Transcript files are automatically deleted after 24 hours.`
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

    async handleInteraction(interaction) {
        if (!interaction.isChatInputCommand()) return;

        const command = this.commands.get(interaction.commandName);
        if (!command) {
            logger.warn(`Unknown command: ${interaction.commandName}`);
            return;
        }

        try {
            await command.execute(interaction);
        } catch (error) {
            logger.error(`Error executing command ${interaction.commandName}:`, error);
            
            const response = { content: '❌ An error occurred while executing this command.', ephemeral: true };
            
            if (interaction.deferred || interaction.replied) {
                await interaction.editReply(response);
            } else {
                await interaction.reply(response);
            }
        }
    }
}

module.exports = CommandHandler;