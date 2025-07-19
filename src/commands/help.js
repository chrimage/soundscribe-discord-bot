const { SlashCommandBuilder } = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('help')
        .setDescription('Show help information about bot commands'),
    
    async execute(interaction) {
        await interaction.reply({
            content: `🤖 **SoundScribe Bot Commands**

**Recording Commands:**
• \`/join\` - Join your voice channel and start recording
• \`/stop\` - Stop recording and process the audio
• \`/transcribe\` - Manually generate transcript from last recording

**Content Commands:**
• \`/summarize [type] [transcript]\` - Generate summary (brief/detailed/key_points)
• \`/list\` - List available recordings and transcripts
• \`/last_recording\` - Get download link for most recent recording

**Utility Commands:**
• \`/ping\` - Test bot responsiveness
• \`/help\` - Show this help message

**How to use:**
1. Join a voice channel
2. Use \`/join\` to start recording
3. Use \`/stop\` when finished
4. Use \`/summarize\` to create summaries

**Note:** All commands work in servers only. Files are automatically deleted after 24 hours.`,
            ephemeral: true
        });
    },
};