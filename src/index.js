const { Client, GatewayIntentBits, PermissionsBitField } = require('discord.js');
const config = require('./config');
const logger = require('./utils/logger');
const CommandHandler = require('./bot/CommandHandler');
const ExpressServer = require('./server/ExpressServer');
const audioProcessor = require('./audio/AudioProcessor');
const _fileManager = require('./utils/fileManager');
const voiceRecorder = require('./audio/VoiceRecorder');

class SoundScribeBot {
    constructor() {
        this.client = new Client({
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildVoiceStates,
                GatewayIntentBits.GuildMessages,
                GatewayIntentBits.MessageContent
            ]
        });

        this.expressServer = new ExpressServer();
        this.commandHandler = new CommandHandler(this.client, this.expressServer);

        // Set the client reference for voice recorder
        voiceRecorder.setClient(this.client);
    }

    async start() {
        try {
            // Validate FFmpeg
            logger.info('Validating FFmpeg installation...');
            await audioProcessor.validateFFmpeg();
            logger.info('FFmpeg validation successful');

            // Start Express server
            this.expressServer.start();

            // Discord bot event handlers
            this.client.once('ready', () => {
                logger.info(`Bot logged in as ${this.client.user.tag}`);
                logger.info(`Connected to ${this.client.guilds.cache.size} guild(s)`);

                // Generate and display invite link
                this.generateInviteLink();

                // Register slash commands
                this.commandHandler.registerCommands();
            });

            this.client.on('interactionCreate', (interaction) => {
                this.commandHandler.handleInteraction(interaction);
            });

            // Handle voice state updates for participant tracking
            this.client.on('voiceStateUpdate', (oldState, newState) => {
                if (oldState.channelId !== newState.channelId) {
                    logger.debug(`User ${newState.member.user.tag} changed voice channels`);
                }
            });

            // Login to Discord
            await this.client.login(config.discord.token);
            logger.info('Bot login successful');

        } catch (error) {
            logger.error('Failed to start bot:', error);
            throw error;
        }
    }

    async stop() {
        logger.info('Shutting down bot...');

        // Stop Express server
        this.expressServer.stop();

        // Disconnect from Discord
        this.client.destroy();

        logger.info('Bot shutdown complete');
    }

    generateInviteLink() {
        // Calculate required permissions for SoundScribe bot
        const permissions = new PermissionsBitField([
            PermissionsBitField.Flags.ViewChannel,          // View channels
            PermissionsBitField.Flags.Connect,              // Connect to voice channels
            PermissionsBitField.Flags.Speak,                // Speak in voice channels
            PermissionsBitField.Flags.UseVAD,               // Use Voice Activity Detection
            PermissionsBitField.Flags.SendMessages,         // Send messages for command responses
            PermissionsBitField.Flags.EmbedLinks,           // Embed links in messages
            PermissionsBitField.Flags.UseApplicationCommands // Use slash commands
        ]);

        const inviteUrl = `https://discord.com/oauth2/authorize?client_id=${this.client.user.id}&permissions=${permissions.bitfield}&scope=bot%20applications.commands`;

        logger.info('\n' + '='.repeat(80));
        logger.info('🤖 DISCORD BOT INVITE LINK');
        logger.info('='.repeat(80));
        logger.info(`📋 Copy this link to invite ${this.client.user.tag} to your server:`);
        logger.info('');
        logger.info(`🔗 ${inviteUrl}`);
        logger.info('');
        logger.info('✅ Required permissions included:');
        logger.info('   • View Channel');
        logger.info('   • Connect (to voice channels)');
        logger.info('   • Speak (in voice channels)');
        logger.info('   • Use Voice Activity');
        logger.info('   • Send Messages');
        logger.info('   • Embed Links');
        logger.info('   • Use Slash Commands');
        logger.info('='.repeat(80) + '\n');
    }
}

// Initialize and start the bot
const bot = new SoundScribeBot();

// Handle graceful shutdown
process.on('SIGINT', async () => {
    logger.info('Received SIGINT, shutting down gracefully...');
    await bot.stop();
    process.exit(0); // eslint-disable-line no-process-exit
});

process.on('SIGTERM', async () => {
    logger.info('Received SIGTERM, shutting down gracefully...');
    await bot.stop();
    process.exit(0); // eslint-disable-line no-process-exit
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
    logger.error('Uncaught exception:', error);
    bot.stop().then(() => process.exit(1)); // eslint-disable-line no-process-exit
});

process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled rejection at:', promise, 'reason:', reason);
});

// Start the bot
bot.start().catch(error => {
    logger.error('Failed to start bot:', error);
    throw error;
});
