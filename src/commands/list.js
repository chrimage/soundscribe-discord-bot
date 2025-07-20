const { SlashCommandBuilder } = require('discord.js');
const path = require('path');
const fs = require('fs');
const config = require('../config');
const logger = require('../utils/logger');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('list')
        .setDescription('List available recordings and transcripts'),

    async execute(interaction, { titleGenerationService, expressServer }) {
        try {
            await interaction.deferReply();

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
    },

    createTranscriptViewerLink(transcriptFilename) {
        const recordingId = transcriptFilename.replace('transcript_', '').replace('.md', '');
        return `${config.express.baseUrl}/?id=${recordingId}`;
    }
};
