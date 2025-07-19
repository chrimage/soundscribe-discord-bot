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
const BackgroundJobManager = require('./BackgroundJobManager');
const { _COMMANDS, _ERROR_MESSAGES } = require('../constants');
const { loadCommands } = require('../commands');

class CommandHandler {
    constructor(client, expressServer) {
        this.client = client;
        this.expressServer = expressServer;
        this.backgroundJobManager = new BackgroundJobManager(expressServer);
        this.commands = new Map();
        this.setupCommands();
        this.setupAutocomplete();
    }

    // Helper function to add timeout to operations
    withTimeout(promise, timeoutMs, operation = 'Operation') {
        return Promise.race([
            promise,
            new Promise((_, reject) => 
                setTimeout(() => reject(new Error(`${operation} timed out after ${timeoutMs/1000}s`)), timeoutMs)
            )
        ]);
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
        // Load external commands with dependency injection
        const dependencies = {
            voiceRecorder,
            audioProcessor,
            fileManager,
            transcriptionService,
            titleGenerationService,
            expressServer: this.expressServer,
            backgroundJobManager: this.backgroundJobManager
        };
        
        const externalCommands = loadCommands(dependencies);
        for (const [name, command] of externalCommands) {
            this.commands.set(name, command);
        }

        // Then add internal commands that need access to class methods
        this.commands.set('join', {
            data: new SlashCommandBuilder()
                .setName('join')
                .setDescription('Join your voice channel and start recording'),
            execute: this.handleJoin.bind(this)
        });

        this.commands.set('last_recording', {
            data: new SlashCommandBuilder()
                .setName('last_recording')
                .setDescription('Get a download link for your most recent recording'),
            execute: this.handleLastRecording.bind(this)
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
            
            // IMMEDIATELY defer reply to prevent timeout
            await interaction.deferReply({ ephemeral: true });
            logger.info(`Join command: Successfully deferred reply`);
            
            // Then validate user is in voice channel
            if (!interaction.member.voice.channel) {
                await interaction.editReply({
                    content: '❌ You must be in a voice channel to start recording!'
                });
                return;
            }

            const guildId = interaction.guild.id;
            const channelName = interaction.member.voice.channel.name;

            // IMMEDIATE response - don't wait for voice connection
            await interaction.editReply({
                content: `🔄 Connecting to voice channel ${channelName}...\n\nThis may take a few moments.`
            });

            // Do voice connection in background without blocking response
            this.startRecordingAsync(interaction, guildId, channelName)
                .catch(error => {
                    logger.error('Background voice connection failed:', error);
                });

            logger.info(`Join command: Responded immediately, starting background connection for guild ${guildId}`);

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
                        ephemeral: true
                    });
                }
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

        // Validate guild context for voice commands
        if (['join', 'stop', 'transcribe'].includes(interaction.commandName)) {
            if (!interaction.guild) {
                await interaction.reply({
                    content: '❌ This command can only be used in servers.',
                    ephemeral: true
                });
                return;
            }
        }

        try {
            await command.execute(interaction);
        } catch (error) {
            logger.error(`Error executing command ${interaction.commandName}:`, error);

            const response = { content: '❌ An error occurred while executing this command.', ephemeral: true };

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

    async startRecordingAsync(interaction, guildId, channelName) {
        try {
            const recordingSession = await voiceRecorder.startRecording(interaction);
            
            // Update with success
            await interaction.editReply({
                content: `🎙️ Started recording in ${channelName}! Use /stop to finish recording.`
            });
            
            logger.info(`Background recording started successfully for guild ${guildId}`);
        } catch (error) {
            logger.error(`Background recording failed for guild ${guildId}:`, error);
            
            // Update with error
            try {
                await interaction.editReply({
                    content: `❌ Failed to start recording: ${error.message}\n\nTry the /join command again.`
                });
            } catch (updateError) {
                logger.error('Failed to update interaction with error:', updateError);
            }
        }
    }


}

module.exports = CommandHandler;
