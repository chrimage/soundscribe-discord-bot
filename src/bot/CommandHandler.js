const { REST, Routes, SlashCommandBuilder } = require('discord.js');
const path = require('path');
const config = require('../config');
const logger = require('../utils/logger');
const voiceRecorder = require('../audio/VoiceRecorder');
const audioProcessor = require('../audio/AudioProcessor');
const fileManager = require('../utils/fileManager');

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
                content: '⏳ Processing audio... This may take a moment.'
            });

            // Process the recording segments
            const processedResult = await audioProcessor.processRecording(
                recordingResult.tempDir,
                recordingResult.outputFile
            );

            // Generate temporary download link
            const fileName = path.basename(processedResult.outputFile);
            const downloadUrl = this.expressServer.createTemporaryUrl(fileName);
            
            const durationMinutes = Math.round(recordingResult.duration / 60000);
            const fileSizeMB = Math.round(processedResult.fileSize / 1024 / 1024 * 100) / 100;

            await interaction.editReply({
                content: `✅ Recording completed!\n\n` +
                        `📊 **Recording Details:**\n` +
                        `• Duration: ${durationMinutes} minutes\n` +
                        `• File size: ${fileSizeMB} MB\n` +
                        `• Participants: ${recordingResult.participants.length}\n` +
                        `• Audio segments: ${processedResult.segmentCount}\n\n` +
                        `📥 **Download:** ${downloadUrl}\n\n` +
                        `⚠️ Files are automatically deleted after 24 hours.`
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