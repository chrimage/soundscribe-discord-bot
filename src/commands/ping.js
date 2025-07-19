const { SlashCommandBuilder } = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('ping')
        .setDescription('Test if the bot is responsive'),
    
    async execute(interaction) {
        await interaction.reply({
            content: `🏓 Pong! Bot latency: ${interaction.client.ws.ping}ms`,
            ephemeral: true
        });
    },
};