const { SlashCommandBuilder } = require('discord.js');
const path = require('path');
const logger = require('../utils/logger');
const config = require('../config');

module.exports = {
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
    
    async execute(interaction, { summarizationService, expressServer }) {
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
            const transcriptResult = await this.findTranscriptFile(transcriptInput, interaction);
            if (!transcriptResult.success) {
                return; // Error already handled
            }

            // Check if summary already exists
            if (summarizationService.summaryExists(transcriptResult.transcriptId, summaryType)) {
                await this.handleExistingSummary(transcriptResult.transcriptId, summaryType, summarizationService, expressServer, interaction);
                return;
            }

            // Generate new summary
            await this.generateNewSummary(transcriptResult.transcriptPath, transcriptResult.transcriptId, summaryType, summarizationService, expressServer, interaction);

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
    },

    async findTranscriptFile(transcriptInput, interaction) {
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
                return { success: false };
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
                return { success: false };
            }

            transcriptPath = path.join(config.paths.recordings, `transcript_${transcriptId}.md`);

            if (!require('fs').existsSync(transcriptPath)) {
                await interaction.editReply({
                    content: `❌ Transcript not found: ${transcriptId}. Use "latest" or check your transcript ID.`
                });
                return { success: false };
            }
        }

        return { success: true, transcriptPath, transcriptId };
    },

    async handleExistingSummary(transcriptId, summaryType, summarizationService, expressServer, interaction) {
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
            const downloadUrl = expressServer.createTemporaryUrl(path.basename(existingSummary.path));
            const webViewerUrl = `${config.express.baseUrl}/summary?id=${transcriptId}&type=${summaryType}`;

            await interaction.editReply({
                content: `📝 **${summaryType.charAt(0).toUpperCase() + summaryType.slice(1)} Summary** (cached)\n\n` +
                        `📄 **View:** [Online](${webViewerUrl}) | [Download](${downloadUrl})\n\n` +
                        '⚠️ Summary files are automatically deleted after 24 hours.'
            });
        }
    },

    async generateNewSummary(transcriptPath, transcriptId, summaryType, summarizationService, expressServer, interaction) {
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
            const downloadUrl = expressServer.createTemporaryUrl(savedSummary.fileName);
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
    }
};