const fs = require('fs');
const FormData = require('form-data');
const axios = require('axios');
const config = require('../config');
const logger = require('../utils/logger');
const audioProcessor = require('../audio/AudioProcessor');

class TranscriptionService {
    constructor() {
        this.groqApiKey = config.groq.apiKey;
        this.groqApiUrl = 'https://api.groq.com/openai/v1/audio/transcriptions';

        if (!this.groqApiKey) {
            throw new Error('Groq API key not configured');
        }
    }

    async transcribeSpeechSegments(speechSegments, userFiles) {
        logger.info(`Starting transcription for ${speechSegments.length} speech segments`);

        const transcripts = [];

        for (const segment of speechSegments) {
            try {
                // Find the corresponding user file
                const userFile = userFiles.find(file => file.userId === segment.userId);
                if (!userFile) {
                    logger.warn(`No audio file found for user ${segment.username} in segment`);
                    continue;
                }

                // Extract audio segment with padding for better Whisper accuracy
                const paddingMs = 500; // Add 500ms padding on each side
                const paddedStart = Math.max(0, segment.relativeStart - paddingMs);
                const paddedDuration = segment.duration + (2 * paddingMs);
                
                const segmentAudio = await this.extractAudioSegment(
                    userFile.filepath,
                    paddedStart,
                    paddedDuration
                );

                // Transcribe the segment
                const transcription = await this.transcribeAudioFile(segmentAudio, segment.username);

                if (transcription && transcription.trim()) {
                    transcripts.push({
                        speaker: segment.displayName || segment.username,
                        speakerId: segment.userId,
                        text: transcription.trim(),
                        timestamp: segment.startTime,
                        duration: segment.duration,
                        relativeStart: segment.relativeStart,
                        relativeEnd: segment.relativeEnd
                    });

                    logger.debug(`Transcribed segment for ${segment.username}: "${transcription.trim().substring(0, 50)}..."`);
                }

                // Clean up temp segment file
                if (fs.existsSync(segmentAudio)) {
                    fs.unlinkSync(segmentAudio);
                }

            } catch (error) {
                logger.error(`Failed to transcribe segment for ${segment.username}:`, error);
                // Continue with other segments
            }
        }

        logger.info(`Completed transcription: ${transcripts.length}/${speechSegments.length} segments successfully transcribed`);
        return transcripts;
    }

    async extractAudioSegment(pcmFilePath, startMs, durationMs) {
        return new Promise((resolve, reject) => {
            const outputPath = pcmFilePath.replace('.pcm', `_segment_${Date.now()}.wav`);

            // Extract segment from PCM file and convert to WAV for transcription
            // Using research-backed Discord PCM specifications
            ffmpeg()
                .input(pcmFilePath)
                .inputFormat('s16le') // 16-bit signed little-endian (Discord standard)
                .inputOptions([
                    '-ar 48000',      // 48kHz sample rate
                    '-ac 2'           // 2 channels stereo (Discord format)
                ])
                .seekInput(startMs / 1000) // Start time in seconds
                .duration(durationMs / 1000) // Duration in seconds
                .audioCodec('pcm_s16le')
                .audioFrequency(48000)
                .audioChannels(1) // Convert to mono for transcription
                .format('wav')
                .output(outputPath)
                .on('end', () => {
                    resolve(outputPath);
                })
                .on('error', (error) => {
                    logger.error(`FFmpeg PCM segment extraction failed: ${error.message}`);
                    reject(error);
                })
                .run();
        });
    }

    async transcribeAudioFile(audioFilePath, speakerName = 'Unknown') {
        try {
            // Check if file exists and has content
            if (!fs.existsSync(audioFilePath)) {
                throw new Error(`Audio file not found: ${audioFilePath}`);
            }

            const stats = fs.statSync(audioFilePath);
            if (stats.size === 0) {
                logger.warn(`Empty audio file for ${speakerName}, skipping transcription`);
                return null;
            }

            // Prepare form data for Groq API
            const formData = new FormData();
            formData.append('file', fs.createReadStream(audioFilePath));
            formData.append('model', 'whisper-large-v3');
            formData.append('language', 'en');
            formData.append('response_format', 'text');

            // Make request to Groq API
            const response = await axios.post(this.groqApiUrl, formData, {
                headers: {
                    'Authorization': `Bearer ${this.groqApiKey}`,
                    ...formData.getHeaders()
                },
                timeout: 30000
            });

            const transcription = response.data;

            if (!transcription || transcription.trim() === '') {
                logger.warn(`Empty transcription received for ${speakerName}`);
                return null;
            }

            logger.debug(`Transcription for ${speakerName}: "${transcription.substring(0, 100)}..."`);
            return transcription;

        } catch (error) {
            if (error.response) {
                logger.error(`Groq API error for ${speakerName}: ${error.response.status} - ${error.response.data}`);
            } else {
                logger.error(`Transcription error for ${speakerName}: ${error.message}`);
            }
            throw error;
        }
    }

    formatTranscript(transcripts) {
        if (!transcripts || transcripts.length === 0) {
            return {
                text: '# Transcript\n\nNo speech detected in recording.',
                metadata: {
                    totalSegments: 0,
                    transcribedSegments: 0,
                    participants: [],
                    duration: 0
                }
            };
        }

        // Sort transcripts by timestamp to ensure chronological order
        transcripts.sort((a, b) => a.timestamp - b.timestamp);

        let markdown = '# Transcript\n\n';
        let totalDuration = 0;
        const participants = new Set();

        for (const transcript of transcripts) {
            const startTime = this.formatTimestamp(transcript.relativeStart);
            participants.add(transcript.speaker);
            totalDuration += transcript.duration;

            markdown += `**${transcript.speaker}** _(${startTime})_: ${transcript.text}\n\n`;
        }

        const metadata = {
            totalSegments: transcripts.length,
            transcribedSegments: transcripts.length,
            participants: Array.from(participants),
            duration: totalDuration,
            generatedAt: new Date().toISOString()
        };

        return {
            text: markdown,
            metadata
        };
    }

    formatTimestamp(milliseconds) {
        const totalSeconds = Math.floor(milliseconds / 1000);
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;
        return `${minutes}:${seconds.toString().padStart(2, '0')}`;
    }

    // Convert PCM to WAV for transcription using standardized pipeline
    async convertPcmToWav(pcmFilePath) {
        const wavFilePath = pcmFilePath.replace('.pcm', '.wav');
        await audioProcessor.convertPcmToWav(pcmFilePath, wavFilePath);
        return wavFilePath;
    }

    // For backward compatibility - transcribe full user files
    async transcribeUserFiles(userFiles) {
        logger.info(`Starting full file transcription for ${userFiles.length} users`);

        const transcripts = [];

        for (const userFile of userFiles) {
            try {
                // Convert PCM to WAV
                const wavFile = await this.convertPcmToWav(userFile.filepath);

                // Transcribe the full file
                const transcription = await this.transcribeAudioFile(wavFile, userFile.username);

                if (transcription && transcription.trim()) {
                    transcripts.push({
                        speaker: userFile.displayName || userFile.username,
                        speakerId: userFile.userId,
                        text: transcription.trim(),
                        timestamp: Date.now(), // No specific timestamp for full file
                        duration: 0,
                        relativeStart: 0,
                        relativeEnd: 0
                    });
                }

                // Clean up WAV file
                if (fs.existsSync(wavFile)) {
                    fs.unlinkSync(wavFile);
                }

            } catch (error) {
                logger.error(`Failed to transcribe full file for ${userFile.username}:`, error);
            }
        }

        return transcripts;
    }

    // Legacy method for backward compatibility with transcribe command
    async transcribeSegments(audioSources) {
        logger.info(`Starting transcription of ${audioSources.length} audio sources`);
        
        const transcriptionResults = [];

        for (const source of audioSources) {
            try {
                logger.info(`Transcribing source ${source.segmentId || source.userId} for ${source.displayName || source.username}`);

                // Convert to appropriate format for transcription
                let audioFile = source.filename;
                let needsCleanup = false;

                // If it's a PCM file, convert to WAV first
                if (source.filename.endsWith('.pcm')) {
                    audioFile = await this.convertPcmToWav(source.filename);
                    needsCleanup = true;
                }

                // Check file size and skip if too large/small
                const fileStats = fs.statSync(audioFile);
                if (fileStats.size > 25000000) { // 25MB limit
                    logger.warn(`Audio file too large (${fileStats.size} bytes), skipping`);
                    transcriptionResults.push({
                        ...source,
                        transcription: '[Audio file too large for transcription]',
                        error: 'FILE_TOO_LARGE'
                    });
                    continue;
                }

                if (fileStats.size < 1000) { // 1KB minimum
                    logger.debug(`Audio file too small (${fileStats.size} bytes), skipping`);
                    transcriptionResults.push({
                        ...source,
                        transcription: '[Audio file too small]',
                        error: 'FILE_TOO_SMALL'
                    });
                    continue;
                }

                // Transcribe the audio
                const transcription = await this.transcribeAudioFile(audioFile, source.displayName || source.username);

                transcriptionResults.push({
                    ...source,
                    transcription: transcription || '[No transcription generated]',
                    success: !!transcription
                });

                // Clean up temporary WAV file if created
                if (needsCleanup && fs.existsSync(audioFile)) {
                    fs.unlinkSync(audioFile);
                }

            } catch (error) {
                logger.error(`Error transcribing segment for ${source.displayName || source.username}:`, error);
                transcriptionResults.push({
                    ...source,
                    transcription: '[Transcription failed]',
                    error: error.message
                });
            }
        }

        return transcriptionResults;
    }
}

module.exports = new TranscriptionService();
