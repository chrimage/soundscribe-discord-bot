const { SlashCommandBuilder } = require('discord.js');
const path = require('path');
const logger = require('../utils/logger');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('stop')
        .setDescription('Stop recording and process the audio'),
    
    async execute(interaction, { voiceRecorder, audioProcessor, expressServer, backgroundJobManager }) {
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

            // Check if any audio was captured
            if (!recordingResult.userFiles || recordingResult.userFiles.length === 0) {
                await this.handleNoAudioCaptured(interaction, recordingResult);
                return;
            }

            // Process audio and create immediate response
            const processedResult = await audioProcessor.createMixedRecording(recordingResult);
            await this.sendImmediateResponse(interaction, recordingResult, processedResult, expressServer);

            // Queue background transcription if possible
            await this.queueBackgroundTranscription(recordingResult, processedResult, interaction, backgroundJobManager);

            // Clean up temp files
            audioProcessor.cleanupTempFiles(recordingResult.tempDir);

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

    async queueBackgroundTranscription(recordingResult, processedResult, interaction, backgroundJobManager) {
        const canTranscribe = recordingResult.speechSegments && recordingResult.speechSegments.length > 0;
        
        if (canTranscribe) {
            const recordingId = path.basename(processedResult.outputFile, '.mp3');
            
            backgroundJobManager.queueTranscription({
                recordingData: recordingResult,
                processedResult: processedResult,
                recordingId: recordingId,
                interaction: interaction // Pass the entire interaction object
            });
            
            logger.info(`Queued background transcription for recording ${recordingId}`);
        }
    }
};