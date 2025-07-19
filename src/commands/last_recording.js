const { SlashCommandBuilder } = require('discord.js');
const logger = require('../utils/logger');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('last_recording')
        .setDescription('Get a download link for your most recent recording'),
    
    async execute(interaction, { fileManager, expressServer }) {
        try {
            await interaction.deferReply();

            const latestFile = await fileManager.getLatestRecording();

            if (!latestFile) {
                await interaction.editReply({
                    content: '❌ No recordings found. Use /join to start a new recording.'
                });
                return;
            }

            const downloadUrl = expressServer.createTemporaryUrl(latestFile.name);
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
};