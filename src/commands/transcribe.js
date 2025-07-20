const { SlashCommandBuilder } = require('discord.js');
const path = require('path');
const fs = require('fs');
const logger = require('../utils/logger');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('transcribe')
        .setDescription('Manually generate transcript from the last recording (if auto-transcription failed)'),

    async execute(interaction, { voiceRecorder, fileManager, transcriptionService, titleGenerationService, expressServer }) {
        try {
            await interaction.deferReply();

            const guildId = interaction.guild.id;

            // Check if there's an active recording
            if (voiceRecorder.isRecordingActive(guildId)) {
                await interaction.editReply({
                    content: '⚠️ Recording is still in progress. Use /stop first to finish recording, then try /transcribe.'
                });
                return;
            }

            // Find the most recent recording session with speech segments
            const latestFile = await fileManager.getLatestRecording();
            if (!latestFile) {
                await interaction.editReply({
                    content: '❌ No recordings found. Use /join to start a recording first.'
                });
                return;
            }

            // Try to find speech segments or fallback to continuous files
            const result = await this.findAudioSources(latestFile, interaction);
            if (!result.success) {
                return; // Error already handled in findAudioSources
            }

            // Transcribe the audio segments
            await this.transcribeAndRespond(result.audioSources, result.isSegmented, interaction, transcriptionService, titleGenerationService, expressServer);

        } catch (error) {
            logger.error('Error in transcribe command:', error);
            await interaction.editReply({
                content: `❌ Failed to generate transcript: ${error.message}`
            });
        }
    },

    async findAudioSources(latestFile, interaction) {
        const metadataPath = latestFile.path.replace('.mp3', '_segments.json');

        // First try: Look for speech segments metadata file
        if (fs.existsSync(metadataPath)) {
            try {
                const metadataContent = fs.readFileSync(metadataPath, 'utf8');
                const speechSegments = JSON.parse(metadataContent);

                if (speechSegments && speechSegments.length > 0) {
                    // Verify segment files still exist
                    const validSegments = speechSegments.filter(segment => fs.existsSync(segment.filename));
                    if (validSegments.length > 0) {
                        return { success: true, audioSources: validSegments, isSegmented: true };
                    }
                }
            } catch (error) {
                logger.error('Failed to parse speech segments metadata:', error);
            }
        }

        // Fallback: Look for continuous user recording files
        const tempDirPath = latestFile.path.replace('.mp3', '').replace('recordings', 'temp');
        if (fs.existsSync(tempDirPath)) {
            const userFiles = this.findContinuousUserFiles(tempDirPath);
            if (userFiles.length > 0) {
                return { success: true, audioSources: userFiles, isSegmented: false };
            }
        }

        // No audio sources found
        await interaction.editReply({
            content: '❌ No speech segments or user recording files found. This recording may not have any audio content.'
        });
        return { success: false };
    },

    findContinuousUserFiles(tempDirPath) {
        const userFiles = fs.readdirSync(tempDirPath)
            .filter(file => file.startsWith('user_') && file.endsWith('.pcm'))
            .map(filename => {
                const filePath = path.join(tempDirPath, filename);
                const stats = fs.statSync(filePath);

                // Skip empty files
                if (stats.size < 1000) {
                    return null;
                }

                // Parse user info from filename: user_userId_username.pcm
                const parts = filename.replace('.pcm', '').split('_');
                const userId = parts[1];
                const username = parts.slice(2).join('_'); // Handle usernames with underscores

                return {
                    segmentId: `continuous_${userId}`,
                    userId,
                    username,
                    displayName: username,
                    startTimestamp: Date.now() - 60000, // Estimate start time
                    endTimestamp: Date.now(),
                    duration: 60000, // Estimate duration
                    filename: filePath
                };
            })
            .filter(Boolean); // Remove null entries

        return userFiles;
    },

    async transcribeAndRespond(audioSources, isSegmented, interaction, transcriptionService, titleGenerationService, expressServer) {
        const segmentType = isSegmented ? 'speech segments' : 'user recordings';

        await interaction.editReply({
            content: `🤖 ${isSegmented ? 'Found' : 'Found continuous recording files. Starting'} transcription of ${audioSources.length} ${segmentType}...\n\n⏳ This may take a few moments${isSegmented ? ' depending on the amount of audio' : ''}.`
        });

        // Transcribe the segments with timeout
        const transcriptionResults = await this.withTimeout(
            transcriptionService.transcribeSegments(audioSources),
            120000,
            'Transcription'
        );

        // Format the transcript
        const transcript = transcriptionService.formatTranscript(transcriptionResults);

        // Save transcript to file
        const transcriptFilename = `transcript_${Date.now()}.md`;
        const transcriptPath = path.join(require('../config').paths.recordings, transcriptFilename);
        fs.writeFileSync(transcriptPath, transcript.text);

        // Generate title for the transcript
        const generatedTitle = await this.generateTitle(transcript.text, transcriptFilename, titleGenerationService);

        // Create response with links
        const downloadUrl = expressServer.createTemporaryUrl(transcriptFilename);
        const webViewerUrl = this.createTranscriptViewerLink(transcriptFilename);

        let responseContent = '✅ **Transcription completed!**\n\n' +
                '📊 **Results:**\n' +
                `• Total segments: ${transcript.metadata.totalSegments}\n` +
                `• Transcribed segments: ${transcript.metadata.transcribedSegments}\n` +
                `• Participants: ${transcript.metadata.participants.join(', ')}\n` +
                `• Duration: ${transcript.metadata.totalDuration}\n\n` +
                `📄 **Transcript:** [View Online](${webViewerUrl}) | [Download](${downloadUrl})\n`;

        if (generatedTitle) {
            responseContent += `🏷️ **Title:** "${generatedTitle.title}"\n`;
        }

        responseContent += '\n⚠️ Transcript files are automatically deleted after 24 hours.';

        if (!isSegmented) {
            responseContent += '\n\n💡 *Note: Used continuous recording mode (speech segmentation not working)*';
        }

        await interaction.editReply({
            content: responseContent
        });
    },

    async generateTitle(transcriptText, transcriptFilename, titleGenerationService) {
        try {
            const transcriptId = transcriptFilename.replace('transcript_', '').replace('.md', '');
            const titleResult = await titleGenerationService.generateTitle(transcriptText);
            await titleGenerationService.saveTitle(titleResult, transcriptId);
            logger.info(`Generated title for manual transcription: "${titleResult.title}"`);
            return titleResult;
        } catch (titleError) {
            logger.error('Failed to generate title for manual transcription:', titleError);
            // Generate fallback title
            try {
                const transcriptId = transcriptFilename.replace('transcript_', '').replace('.md', '');
                const fallbackTitle = titleGenerationService.generateFallbackTitle(transcriptId);
                await titleGenerationService.saveTitle(fallbackTitle, transcriptId);
                return fallbackTitle;
            } catch (fallbackError) {
                logger.error('Failed to generate fallback title:', fallbackError);
                return null;
            }
        }
    },

    createTranscriptViewerLink(transcriptFilename) {
        const recordingId = transcriptFilename.replace('transcript_', '').replace('.md', '');
        const config = require('../config');
        return `${config.express.baseUrl}/?id=${recordingId}`;
    },

    // Helper function to add timeout to operations
    withTimeout(promise, timeoutMs, operation = 'Operation') {
        return Promise.race([
            promise,
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error(`${operation} timed out after ${timeoutMs/1000}s`)), timeoutMs)
            )
        ]);
    }
};
