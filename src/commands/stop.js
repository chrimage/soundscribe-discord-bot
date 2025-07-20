const { SlashCommandBuilder } = require('discord.js');
const path = require('path');
const fs = require('fs');
const logger = require('../utils/logger');
const transcriptionService = require('../services/TranscriptionService');
const titleGenerationService = require('../services/TitleGenerationService');
const summarizationService = require('../services/SummarizationService');
const config = require('../config');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('stop')
        .setDescription('Stop recording and process the audio'),
    
    async execute(interaction, { voiceRecorder, audioProcessor, expressServer }) {
        try {
            await interaction.deferReply({ ephemeral: true });

            const guildId = interaction.guild.id;
            logger.info(`Stop command: Attempting to stop recording for guild ${guildId}`);

            // Check if recording is active before trying to stop
            if (!voiceRecorder.isRecordingActive(guildId)) {
                logger.warn(`Stop command: No active recording found for guild ${guildId}`);
                logger.info(`Stop command: Active recordings: ${JSON.stringify(voiceRecorder.getAllActiveRecordings())}`);

                await interaction.editReply({
                    content: '❌ No active recording found. Use /join to start a recording first.'
                });
                return;
            }

            // Immediately update with processing status
            await interaction.editReply({
                content: '🔄 Stopping recording and processing audio...'
            });

            const recordingResult = await voiceRecorder.stopRecording(guildId);

            // Respond immediately to avoid timeout
            await interaction.editReply({
                content: '🔄 Processing recording... This may take a moment.'
            });

            // Check if any audio was captured
            if (!recordingResult.userFiles || recordingResult.userFiles.length === 0) {
                await this.handleNoAudioCaptured(interaction, recordingResult);
                return;
            }

            // Start complete processing pipeline in background (fire and forget)
            this.processCompleteRecording(recordingResult, interaction, audioProcessor, expressServer)
                .catch(error => {
                    logger.error('Complete recording pipeline failed:', {
                        error: error.message,
                        stack: error.stack
                    });
                });

        } catch (error) {
            logger.error('Error in stop command:', error);
            try {
                await interaction.editReply({
                    content: `❌ Failed to stop recording: ${error.message}`
                });
            } catch (interactionError) {
                logger.error('Failed to respond to interaction (may have timed out):', interactionError);
            }
        }
    },

    async handleNoAudioCaptured(interaction, recordingResult) {
        const durationMinutes = Math.round(recordingResult.duration / 60000);

        await interaction.editReply({
            content: '⚠️ **No audio captured**\n\n' +
                    '📊 **Recording Details:**\n' +
                    `• Duration: ${durationMinutes} minutes\n` +
                    `• Participants: ${recordingResult.participants.length}\n` +
                    '• Audio files: 0\n\n' +
                    '💡 **Possible reasons:**\n' +
                    '• No one spoke during recording\n' +
                    '• Microphones were muted\n' +
                    '• Voice activity detection threshold not met\n' +
                    '• Bot permissions issue\n\n' +
                    'Try recording again and make sure someone speaks clearly.'
        });
    },

    async sendImmediateResponse(interaction, recordingResult, processedResult, expressServer) {
        const fileName = path.basename(processedResult.outputFile);
        const downloadUrl = expressServer.createTemporaryUrl(fileName);
        const durationMinutes = Math.round(recordingResult.duration / 60000);
        const fileSizeMB = Math.round(processedResult.fileSize / 1024 / 1024 * 100) / 100;

        // Check if we have speech segments for transcription
        const canTranscribe = recordingResult.speechSegments && recordingResult.speechSegments.length > 0;

        // Build immediate response
        let immediateResponse = '🎙️ **Recording Complete!**\n\n';
        immediateResponse += '🔗 **Audio Recording:**\n';
        immediateResponse += `• 🎵 [Download MP3](${downloadUrl}) (${fileSizeMB} MB)\n\n`;
        immediateResponse += '📊 **Recording Details:**\n';
        immediateResponse += `• Duration: ${durationMinutes} minutes\n`;
        immediateResponse += `• Participants: ${recordingResult.participants.length}\n`;
        immediateResponse += `• Speech segments: ${recordingResult.speechSegments ? recordingResult.speechSegments.length : 0}\n\n`;

        if (canTranscribe) {
            immediateResponse += '⏳ **Transcript:** Processing speech segments...\n';
            immediateResponse += 'I\'ll update this message when transcription is complete!\n\n';
        } else {
            immediateResponse += '⚠️ **Transcript:** No speech segments detected\n\n';
        }

        immediateResponse += '⚠️ *Files expire in 24 hours*';

        await interaction.editReply({ content: immediateResponse });
    },

    async processCompleteRecording(recordingResult, interaction, audioProcessor, expressServer) {
        const recordingId = `recording_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5)}Z`;
        logger.info(`Starting complete recording pipeline for ${recordingId}`);

        try {
            // Step 1: Process audio and create MP3
            await interaction.editReply({
                content: '🔄 Processing audio and creating MP3...'
            });

            const processedResult = await audioProcessor.createMixedRecording(recordingResult);
            
            // Step 2: Show immediate response with MP3 download
            await this.sendImmediateResponse(interaction, recordingResult, processedResult, expressServer);

            // Step 3: Continue with transcription pipeline if possible
            await this.processTranscriptionPipeline(recordingResult, processedResult, interaction, expressServer);

        } catch (error) {
            logger.error(`Complete recording pipeline failed for ${recordingId}:`, {
                error: error.message,
                stack: error.stack
            });

            try {
                await interaction.editReply({
                    content: '❌ **Recording processing failed**\n\n' +
                            `• Error: ${error.message}\n\n` +
                            'Please try recording again.'
                });
            } catch (updateError) {
                logger.error('Failed to update failed recording:', updateError);
            }
        } finally {
            // Clean up temp files
            if (recordingResult.tempDir) {
                audioProcessor.cleanupTempFiles(recordingResult.tempDir);
                logger.debug(`Cleaned up temp directory: ${recordingResult.tempDir}`);
            }
        }
    },

    async processTranscriptionPipeline(recordingResult, processedResult, interaction, expressServer) {
        const canTranscribe = recordingResult.speechSegments && recordingResult.speechSegments.length > 0;
        
        if (!canTranscribe) {
            logger.info('No speech segments detected, skipping transcription pipeline');
            return;
        }

        const recordingId = path.basename(processedResult.outputFile, '.mp3');
        logger.info(`Starting transcription pipeline for recording ${recordingId}`);

        try {
            // Step 1: Update Discord - "Transcribing..."
            await interaction.editReply({
                content: this.buildProgressResponse(processedResult, "🤖 Transcribing speech segments...", expressServer)
            });

            // Step 2: Transcribe speech segments
            const transcriptionResults = await transcriptionService.transcribeSpeechSegments(
                recordingResult.speechSegments,
                recordingResult.userFiles
            );
            const transcript = transcriptionService.formatTranscript(transcriptionResults);

            // Step 3: Save transcript to file
            const transcriptFilename = `transcript_${recordingId}.md`;
            const transcriptPath = path.join(config.paths.recordings, transcriptFilename);
            fs.writeFileSync(transcriptPath, transcript.text);

            // Step 4: Update Discord - "Generating title..."
            await interaction.editReply({
                content: this.buildProgressResponse(processedResult, "📝 Generating title and summary...", expressServer)
            });

            // Step 5: Generate title and summary
            let generatedTitle = null;
            let briefSummary = null;

            // Generate title
            try {
                const titleResult = await titleGenerationService.generateTitle(transcript.text);
                await titleGenerationService.saveTitle(titleResult, recordingId);
                generatedTitle = titleResult;
                logger.info(`Generated title: "${titleResult.title}"`);
            } catch (titleError) {
                logger.error(`Failed to generate title:`, {
                    error: titleError.message,
                    stack: titleError.stack,
                    recordingId: recordingId
                });
                // Generate fallback title
                try {
                    const fallbackTitle = titleGenerationService.generateFallbackTitle(recordingId);
                    await titleGenerationService.saveTitle(fallbackTitle, recordingId);
                    generatedTitle = fallbackTitle;
                } catch (fallbackError) {
                    logger.error(`Failed to generate fallback title:`, fallbackError);
                }
            }

            // Generate brief summary (separate try/catch)
            try {
                const summaryResult = await summarizationService.summarizeTranscript(transcriptPath, 'brief');
                briefSummary = summaryResult.summary;
                logger.info(`Generated brief summary`);
            } catch (summaryError) {
                logger.error(`Failed to generate summary:`, {
                    error: summaryError.message,
                    stack: summaryError.stack,
                    recordingId: recordingId
                });
                // Continue without summary
            }

            // Step 6: Build final response and update Discord
            const finalResponse = this.buildCompletedResponse(
                processedResult,
                transcript,
                generatedTitle,
                briefSummary,
                recordingResult,
                recordingId,
                expressServer
            );

            await interaction.editReply({ content: finalResponse });
            logger.info(`Completed transcription pipeline for recording ${recordingId}`);

        } catch (error) {
            logger.error(`Transcription pipeline failed for ${recordingId}:`, {
                error: error.message,
                stack: error.stack,
                recordingId: recordingId
            });

            try {
                await interaction.editReply({
                    content: this.buildErrorResponse(processedResult, error.message, expressServer)
                });
            } catch (updateError) {
                logger.error(`Failed to update failed pipeline:`, {
                    error: updateError.message,
                    code: updateError.code
                });
            }
        } finally {
            // Clean up temp files after pipeline completes
            if (recordingResult.tempDir) {
                const audioProcessor = require('../audio/AudioProcessor');
                audioProcessor.cleanupTempFiles(recordingResult.tempDir);
                logger.debug(`Cleaned up temp directory: ${recordingResult.tempDir}`);
            }
        }
    },

    buildProgressResponse(processedResult, statusMessage, expressServer) {
        const downloadUrl = expressServer.createTemporaryUrl(path.basename(processedResult.outputFile));
        const fileSizeMB = Math.round(processedResult.fileSize / 1024 / 1024 * 100) / 100;

        return '🎙️ **Recording Complete!**\n\n' +
               '🔗 **Audio Recording:**\n' +
               `• 🎵 [Download MP3](${downloadUrl}) (${fileSizeMB} MB)\n\n` +
               `${statusMessage}\n\n` +
               '⚠️ *Files expire in 24 hours*';
    },

    buildCompletedResponse(processedResult, transcript, generatedTitle, briefSummary, recordingData, recordingId, expressServer) {
        const downloadUrl = expressServer.createTemporaryUrl(path.basename(processedResult.outputFile));
        const fileSizeMB = Math.round(processedResult.fileSize / 1024 / 1024 * 100) / 100;
        const durationMinutes = Math.round(recordingData.duration / 60000);

        // Create URLs
        const transcriptFilename = `transcript_${recordingId}.md`;
        const transcriptUrl = expressServer.createTemporaryUrl(transcriptFilename);
        const webViewerUrl = `${config.express.baseUrl}/?id=${recordingId}`;
        const detailedSummaryUrl = `${config.express.baseUrl}/summary?id=${recordingId}&type=detailed`;

        let response = '🎙️ **Recording Complete!**\n\n';

        // Add title if available
        if (generatedTitle) {
            response += `📝 **"${generatedTitle.title}"**\n\n`;
        }

        // Add summary if available
        if (briefSummary) {
            const maxSummaryLength = 800;
            const displaySummary = briefSummary.length > maxSummaryLength
                ? briefSummary.substring(0, maxSummaryLength) + '...'
                : briefSummary;
            response += `📋 **Summary:**\n${displaySummary}\n\n`;
        }

        response += '🔗 **Links:**\n';
        response += `• 🎵 [Audio Recording](${downloadUrl})\n`;
        response += `• 📄 [Transcript](${webViewerUrl}) | [Download](${transcriptUrl})\n`;
        response += `• 📊 [Detailed Summary](${detailedSummaryUrl})\n\n`;

        response += '📊 **Stats:**\n';
        response += `• Duration: ${durationMinutes} minutes\n`;
        response += `• File size: ${fileSizeMB} MB\n`;
        response += `• Participants: ${transcript.metadata.participants.join(', ')}\n`;
        response += `• Transcribed: ${transcript.metadata.transcribedSegments}/${transcript.metadata.totalSegments} segments\n\n`;

        response += '⚠️ *Files expire in 24 hours*';

        return response;
    },

    buildErrorResponse(processedResult, errorMessage, expressServer) {
        const downloadUrl = expressServer.createTemporaryUrl(path.basename(processedResult.outputFile));
        const fileSizeMB = Math.round(processedResult.fileSize / 1024 / 1024 * 100) / 100;

        return '🎙️ **Recording Complete!**\n\n' +
               '🔗 **Audio Recording:**\n' +
               `• 🎵 [Download MP3](${downloadUrl}) (${fileSizeMB} MB)\n\n` +
               '⚠️ **Transcript:** Generation failed, but you can try /transcribe later\n' +
               `• Error: ${errorMessage}\n\n` +
               '⚠️ *Files expire in 24 hours*';
    }
};