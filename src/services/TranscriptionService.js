const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
const axios = require('axios');
const logger = require('../utils/logger');

class TranscriptionService {
    constructor() {
        this.groqApiKey = process.env.GROQ_API_KEY;
        this.groqBaseUrl = 'https://api.groq.com/openai/v1';
        
        if (!this.groqApiKey) {
            logger.warn('GROQ_API_KEY not found in environment variables');
        }
    }

    async transcribeSegments(speechSegments) {
        if (!this.groqApiKey) {
            throw new Error('Groq API key not configured');
        }

        const transcriptionResults = [];
        
        logger.info(`Starting transcription of ${speechSegments.length} speech segments`);

        for (const segment of speechSegments) {
            try {
                logger.info(`Transcribing segment ${segment.segmentId} for ${segment.displayName}`);
                
                // Convert PCM to WAV for Groq API
                const wavFile = await this.convertPcmToWav(segment.filename);
                
                // Check file size (Groq has 100MB limit)
                const fileStats = fs.statSync(wavFile);
                if (fileStats.size > 100 * 1024 * 1024) {
                    logger.warn(`Segment ${segment.segmentId} too large (${fileStats.size} bytes), skipping`);
                    transcriptionResults.push({
                        ...segment,
                        transcription: '[Audio segment too large for transcription]',
                        error: 'File size exceeds API limit'
                    });
                    continue;
                }

                // Skip very small files (likely silence) - increased threshold
                if (fileStats.size < 10000) {  // Increased from 1000 to 10000 bytes
                    logger.debug(`Segment ${segment.segmentId} too small (${fileStats.size} bytes), skipping`);
                    transcriptionResults.push({
                        ...segment,
                        transcription: '[Audio segment too small]',
                        error: 'File too small - likely silence or background noise'
                    });
                    continue;
                }

                // Additional quality check: analyze audio energy before conversion
                const audioQuality = await this.analyzeAudioQuality(segment.filename);
                if (audioQuality.avgEnergy < 0.01) {  // Very low energy = likely silence
                    logger.debug(`Segment ${segment.segmentId} has very low audio energy (${audioQuality.avgEnergy}), skipping`);
                    transcriptionResults.push({
                        ...segment,
                        transcription: '[Low audio energy detected]',
                        error: 'Audio energy too low - likely silence'
                    });
                    continue;
                }

                const transcription = await this.transcribeFile(wavFile);
                
                transcriptionResults.push({
                    ...segment,
                    transcription: transcription.text || '[Transcription failed]',
                    confidence: transcription.confidence,
                    language: transcription.language
                });

                // Clean up WAV file
                try {
                    fs.unlinkSync(wavFile);
                } catch (error) {
                    logger.error(`Failed to clean up WAV file ${wavFile}:`, error);
                }

            } catch (error) {
                logger.error(`Failed to transcribe segment ${segment.segmentId}:`, error);
                transcriptionResults.push({
                    ...segment,
                    transcription: '[Transcription error]',
                    error: error.message
                });
            }
        }

        return transcriptionResults;
    }

    async transcribeFile(audioFilePath) {
        if (!fs.existsSync(audioFilePath)) {
            throw new Error(`Audio file not found: ${audioFilePath}`);
        }

        const formData = new FormData();
        formData.append('file', fs.createReadStream(audioFilePath));
        formData.append('model', 'whisper-large-v3-turbo'); // Fast model for real-time feel
        formData.append('language', 'en'); // Can be made configurable
        formData.append('response_format', 'verbose_json'); // Get confidence scores

        try {
            const response = await axios.post(`${this.groqBaseUrl}/audio/transcriptions`, formData, {
                headers: {
                    'Authorization': `Bearer ${this.groqApiKey}`,
                    ...formData.getHeaders()
                },
                timeout: 30000 // 30 second timeout
            });

            return {
                text: response.data.text,
                language: response.data.language,
                confidence: this.calculateAverageConfidence(response.data.segments)
            };

        } catch (error) {
            if (error.response) {
                logger.error(`Groq API error: ${error.response.status} - ${error.response.data?.error?.message || 'Unknown error'}`);
                throw new Error(`Transcription API error: ${error.response.status}`);
            } else if (error.code === 'ECONNABORTED') {
                throw new Error('Transcription request timed out');
            } else {
                throw new Error(`Network error: ${error.message}`);
            }
        }
    }

    calculateAverageConfidence(segments) {
        if (!segments || segments.length === 0) return null;
        
        const totalLogProb = segments.reduce((sum, segment) => {
            return sum + (segment.avg_logprob || -1.0);
        }, 0);
        
        const avgLogProb = totalLogProb / segments.length;
        
        // Convert log probability to percentage confidence
        // Log probabilities are typically -∞ to 0, where 0 is perfect confidence
        // We'll convert to 0-100% where -1.0 ≈ 37%, -2.0 ≈ 14%, etc.
        const confidencePercent = Math.max(0, Math.min(100, Math.exp(avgLogProb) * 100));
        
        return confidencePercent;
    }

    async convertPcmToWav(pcmFilePath) {
        const ffmpeg = require('fluent-ffmpeg');
        const wavFilePath = pcmFilePath.replace('.pcm', '.wav');

        return new Promise((resolve, reject) => {
            ffmpeg(pcmFilePath)
                .inputFormat('s16le') // 16-bit signed little endian
                .inputOptions([
                    '-ar 48000', // 48kHz sample rate (Discord's native rate)
                    '-ac 2'      // 2 channels (stereo)
                ])
                .outputFormat('wav')
                .audioCodec('pcm_s16le')
                .audioFrequency(16000) // Downsample to 16kHz for Whisper (optimal)
                .audioChannels(1)      // Convert to mono
                .on('start', (commandLine) => {
                    logger.debug(`FFmpeg started: ${commandLine}`);
                })
                .on('end', () => {
                    logger.debug(`Converted ${pcmFilePath} to WAV`);
                    resolve(wavFilePath);
                })
                .on('error', (err) => {
                    logger.error(`FFmpeg error converting ${pcmFilePath}:`, err);
                    reject(err);
                })
                .save(wavFilePath);
        });
    }

    formatTranscript(transcriptionResults) {
        // Sort segments by start timestamp
        const sortedResults = transcriptionResults
            .filter(result => result.transcription && result.transcription !== '[No speech detected]')
            .sort((a, b) => a.startTimestamp - b.startTimestamp);

        if (sortedResults.length === 0) {
            return {
                text: 'No transcribable speech detected in this recording.',
                metadata: {
                    totalSegments: transcriptionResults.length,
                    transcribedSegments: 0,
                    processingDate: new Date().toISOString()
                }
            };
        }

        const lines = [];
        lines.push('# Voice Channel Transcript\n');
        
        // Add metadata
        const metadata = this.generateMetadata(transcriptionResults);
        lines.push(`**Recording Date:** ${metadata.recordingDate}`);
        lines.push(`**Duration:** ${metadata.totalDuration}`);
        lines.push(`**Participants:** ${metadata.participants.join(', ')}`);
        lines.push(`**Total Speech Segments:** ${metadata.transcribedSegments}/${metadata.totalSegments}\n`);
        lines.push('---\n');

        // Add transcript
        for (const result of sortedResults) {
            const timestamp = new Date(result.startTimestamp).toISOString().substr(11, 8); // HH:MM:SS
            const speaker = result.displayName || result.username;
            const confidence = result.confidence ? ` (${result.confidence.toFixed(1)}%)` : '';
            
            lines.push(`**[${timestamp}] ${speaker}${confidence}:**`);
            lines.push(`${result.transcription}\n`);
        }

        return {
            text: lines.join('\n'),
            metadata
        };
    }

    generateMetadata(transcriptionResults) {
        const participants = [...new Set(transcriptionResults.map(r => r.displayName || r.username))];
        const transcribedSegments = transcriptionResults.filter(r => 
            r.transcription && 
            r.transcription !== '[No speech detected]' && 
            r.transcription !== '[Transcription error]' &&
            r.transcription !== '[Audio segment too large for transcription]'
        ).length;

        const firstTimestamp = Math.min(...transcriptionResults.map(r => r.startTimestamp));
        const lastTimestamp = Math.max(...transcriptionResults.map(r => r.endTimestamp || r.startTimestamp));
        const totalDuration = Math.round((lastTimestamp - firstTimestamp) / 1000); // seconds

        return {
            recordingDate: new Date(firstTimestamp).toISOString(),
            totalDuration: this.formatDuration(totalDuration),
            participants,
            totalSegments: transcriptionResults.length,
            transcribedSegments,
            processingDate: new Date().toISOString()
        };
    }

    formatDuration(seconds) {
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        const secs = seconds % 60;

        if (hours > 0) {
            return `${hours}h ${minutes}m ${secs}s`;
        } else if (minutes > 0) {
            return `${minutes}m ${secs}s`;
        } else {
            return `${secs}s`;
        }
    }

    async analyzeAudioQuality(pcmFilePath) {
        const fs = require('fs');
        
        try {
            // Read PCM file and calculate RMS energy
            const buffer = fs.readFileSync(pcmFilePath);
            
            // PCM is 16-bit signed little endian, 2 channels (stereo)
            const samples = [];
            for (let i = 0; i < buffer.length - 1; i += 2) {
                const sample = buffer.readInt16LE(i);
                samples.push(sample / 32768.0); // Normalize to -1.0 to 1.0
            }
            
            // Calculate RMS (Root Mean Square) energy
            let sumSquares = 0;
            for (const sample of samples) {
                sumSquares += sample * sample;
            }
            const rmsEnergy = Math.sqrt(sumSquares / samples.length);
            
            // Calculate peak amplitude
            const peakAmplitude = Math.max(...samples.map(Math.abs));
            
            logger.debug(`Audio quality: RMS=${rmsEnergy.toFixed(4)}, Peak=${peakAmplitude.toFixed(4)}, Samples=${samples.length}`);
            
            return {
                avgEnergy: rmsEnergy,
                peakAmplitude: peakAmplitude,
                sampleCount: samples.length,
                isLikelySilence: rmsEnergy < 0.01 && peakAmplitude < 0.05
            };
            
        } catch (error) {
            logger.error(`Failed to analyze audio quality for ${pcmFilePath}:`, error);
            // Return permissive values on error so we don't skip valid audio
            return {
                avgEnergy: 1.0,
                peakAmplitude: 1.0,
                sampleCount: 0,
                isLikelySilence: false
            };
        }
    }
}

module.exports = new TranscriptionService();