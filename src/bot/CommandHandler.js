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
const { loadCommands } = require('../commands');
const ErrorHandler = require('../utils/ErrorHandler');

class CommandHandler {
    constructor(client, expressServer) {
        this.client = client;
        this.expressServer = expressServer;
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
            summarizationService,
            expressServer: this.expressServer
        };
        
        const externalCommands = loadCommands(dependencies);
        for (const [name, command] of externalCommands) {
            // Wrap each command with error handling
            const wrappedCommand = {
                data: command.data,
                execute: ErrorHandler.wrapCommand(command.execute, name)
            };
            this.commands.set(name, wrappedCommand);
        }

        logger.info(`Loaded ${this.commands.size} commands with error handling`);
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

        // Execute command (error handling is now done by ErrorHandler wrapper)
        await command.execute(interaction);
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



}

module.exports = CommandHandler;
