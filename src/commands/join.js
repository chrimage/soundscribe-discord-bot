const { SlashCommandBuilder } = require('discord.js');
const logger = require('../utils/logger');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('join')
        .setDescription('Join your voice channel and start recording'),
    
    async execute(interaction, { voiceRecorder }) {
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
            this.startRecordingAsync(interaction, guildId, channelName, voiceRecorder)
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
    },

    async startRecordingAsync(interaction, guildId, channelName, voiceRecorder) {
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
};