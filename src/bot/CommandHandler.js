const { REST, Routes } = require('discord.js');
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
