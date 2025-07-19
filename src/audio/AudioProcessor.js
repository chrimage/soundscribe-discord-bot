const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const logger = require('../utils/logger');

class AudioProcessor {
    constructor() {
        this.ffmpegPath = config.audio.ffmpegPath;
        if (this.ffmpegPath) {
            ffmpeg.setFfmpegPath(this.ffmpegPath);
        }
    }

    async validateFFmpeg() {
        return new Promise((resolve, reject) => {
            ffmpeg.getAvailableFormats((err, formats) => {
                if (err) {
                    reject(new Error('FFmpeg not found or not working properly'));
                } else {
                    resolve(true);
                }
            });
        });
    }

    async createMixedRecording(recordingResult) {
        const { userFiles } = recordingResult;

        if (!userFiles || userFiles.length === 0) {
            throw new Error('No audio files to process - recording may have been too short or no one spoke');
        }

        try {

            // Generate output filename - try WAV instead of OGG
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const outputFile = path.join(config.paths.recordings, `recording_${timestamp}.wav`);

            // If only one user, convert PCM to WAV
            if (userFiles.length === 1) {
                const userFile = userFiles[0];
                
                // Check if PCM file exists and has content
                if (!fs.existsSync(userFile.filepath)) {
                    throw new Error(`PCM file not found: ${userFile.filepath}`);
                }
                
                const pcmStats = fs.statSync(userFile.filepath);
                if (pcmStats.size === 0) {
                    throw new Error(`PCM file is empty: ${userFile.filepath} (0 bytes)`);
                }
                
                logger.info(`Converting PCM file: ${userFile.filepath} (${Math.round(pcmStats.size / 1024)}KB)`);
                
                // Convert PCM file to WAV using correct Discord format
                await this.convertPcmToWav(userFile.filepath, outputFile);

                const stats = fs.statSync(outputFile);
                logger.info(`Created WAV from PCM: ${outputFile} (${Math.round(stats.size / 1024)}KB)`);

                return {
                    outputFile: outputFile,
                    fileSize: stats.size,
                    participants: userFiles.length
                };
            }

            // Multiple users - create mixed audio as WAV from PCM files
            await this.mixUserAudioFilesToWav(userFiles, outputFile);

            const stats = fs.statSync(outputFile);
            logger.info(`Created mixed recording: ${outputFile} (${Math.round(stats.size / 1024)}KB)`);

            return {
                outputFile,
                fileSize: stats.size,
                participants: userFiles.length
            };

        } catch (error) {
            logger.error(`Audio processing failed: ${error.message}`);
            throw error;
        }
    }

    async convertPcmToWav(pcmFilePath, outputPath) {
        // ORIGINAL WORKING FORMAT: 48kHz stereo 16-bit from Opus decoder
        return new Promise((resolve, reject) => {
            ffmpeg()
                .input(pcmFilePath)
                .inputFormat('s16le')
                .inputOptions(['-ar', '48000', '-ac', '2'])  // STEREO as original
                .audioCodec('pcm_s16le')
                .format('wav')
                .output(outputPath)
                .on('end', () => {
                    logger.debug(`Converted PCM to WAV: ${path.basename(outputPath)}`);
                    resolve();
                })
                .on('error', (error) => {
                    logger.error(`PCM to WAV conversion failed: ${error.message}`);
                    reject(error);
                })
                .run();
        });
    }

    // Removed complex format testing - keeping it simple

    async decodeOpusToWav(opusFilePath, outputPath) {
        // Only used for transcription - decode Opus to WAV
        return new Promise((resolve, reject) => {
            ffmpeg()
                .input(opusFilePath)
                .audioCodec('pcm_s16le')
                .audioFrequency(48000)
                .audioChannels(1) // Mono for transcription
                .format('wav')
                .output(outputPath)
                .on('end', () => {
                    logger.debug(`Decoded Opus to WAV: ${path.basename(outputPath)}`);
                    resolve();
                })
                .on('error', (error) => {
                    logger.error(`Opus to WAV decoding failed: ${error.message}`);
                    reject(error);
                })
                .run();
        });
    }

    async mixOpusFilesToWav(userFiles, outputPath) {
        // Mix Opus files into a single WAV file
        return new Promise((resolve, reject) => {
            const command = ffmpeg();

            // Add each user's Opus file as input
            for (const userFile of userFiles) {
                command.input(userFile.filepath);
            }

            // Create amix filter for combining all inputs
            const filterChain = userFiles.length > 1
                ? `amix=inputs=${userFiles.length}:duration=longest:dropout_transition=2`
                : 'anull';

            command
                .complexFilter([filterChain])
                .audioCodec('pcm_s16le')  // Output as uncompressed WAV
                .audioFrequency(48000)    // Match Discord's sample rate
                .audioChannels(1)         // Mono output
                .format('wav')
                .output(outputPath)
                .on('end', () => {
                    logger.debug(`Mixed ${userFiles.length} Opus streams into WAV: ${path.basename(outputPath)}`);
                    resolve();
                })
                .on('error', (error) => {
                    logger.error(`Opus WAV mixing failed: ${error.message}`);
                    reject(error);
                })
                .run();
        });
    }

    async mixUserAudioFilesToWav(userFiles, outputPath) {
        // ORIGINAL WORKING FORMAT: 48kHz stereo 16-bit from Opus decoder
        return new Promise((resolve, reject) => {
            const command = ffmpeg();

            // Add each user's PCM file as input with ORIGINAL format
            for (const userFile of userFiles) {
                command.input(userFile.filepath)
                    .inputFormat('s16le')
                    .inputOptions(['-ar', '48000', '-ac', '2']);  // STEREO as original
            }

            // Create amix filter for combining all inputs
            const filterChain = userFiles.length > 1
                ? `amix=inputs=${userFiles.length}:duration=longest:dropout_transition=0`  // Original settings
                : 'anull';

            command
                .complexFilter([filterChain])
                .audioCodec('pcm_s16le')  // Keep as uncompressed PCM
                .format('wav')
                .output(outputPath)
                .on('end', () => {
                    logger.debug(`Mixed ${userFiles.length} PCM streams into WAV: ${path.basename(outputPath)}`);
                    resolve();
                })
                .on('error', (error) => {
                    logger.error(`PCM WAV mixing failed: ${error.message}`);
                    reject(error);
                })
                .run();
        });
    }

    async mixUserAudioFiles(userFiles, outputPath) {
        // Keep the old OGG method for fallback
        return new Promise((resolve, reject) => {
            const command = ffmpeg();

            for (const userFile of userFiles) {
                command.input(userFile.filepath)
                    .inputFormat('s16le')
                    .inputOptions(['-ar', '48000', '-ac', '2']);
            }

            const filterChain = userFiles.length > 1
                ? `amix=inputs=${userFiles.length}:duration=longest:dropout_transition=2`
                : 'anull';

            command
                .complexFilter([filterChain])
                .audioCodec('libvorbis')
                .audioBitrate('128k')
                .format('ogg')
                .output(outputPath)
                .on('end', () => {
                    logger.debug(`Mixed ${userFiles.length} PCM streams into: ${path.basename(outputPath)}`);
                    resolve();
                })
                .on('error', (error) => {
                    logger.error(`PCM mixing failed: ${error.message}`);
                    reject(error);
                })
                .run();
        });
    }

    async convertOpusToWav(opusFilePath, outputPath = null) {
        return new Promise((resolve, reject) => {
            const wavFilePath = outputPath || opusFilePath.replace('.opus', '.wav');

            // Try multiple approaches to handle Discord.js Opus format
            const tryConversions = [
                // Approach 1: Treat as raw Opus stream
                () => ffmpeg()
                    .input(opusFilePath)
                    .inputFormat('s16le')  // Try as raw PCM first
                    .inputOptions(['-ar', '48000', '-ac', '2'])
                    .audioCodec('pcm_s16le')
                    .audioFrequency(48000)
                    .audioChannels(1)
                    .format('wav')
                    .output(wavFilePath),
                
                // Approach 2: Treat as OGG Opus
                () => ffmpeg()
                    .input(opusFilePath)
                    .inputFormat('ogg')
                    .audioCodec('pcm_s16le')
                    .audioFrequency(48000)
                    .audioChannels(1)
                    .format('wav')
                    .output(wavFilePath),
                
                // Approach 3: No input format specified (let FFmpeg detect)
                () => ffmpeg()
                    .input(opusFilePath)
                    .audioCodec('pcm_s16le')
                    .audioFrequency(48000)
                    .audioChannels(1)
                    .format('wav')
                    .output(wavFilePath)
            ];

            let currentApproach = 0;
            
            const tryNext = () => {
                if (currentApproach >= tryConversions.length) {
                    reject(new Error('All Opus conversion approaches failed'));
                    return;
                }
                
                const command = tryConversions[currentApproach]();
                currentApproach++;
                
                command
                    .on('end', () => {
                        logger.debug(`Converted Opus to WAV (approach ${currentApproach}): ${path.basename(wavFilePath)}`);
                        resolve(wavFilePath);
                    })
                    .on('error', (error) => {
                        logger.warn(`Opus conversion approach ${currentApproach} failed: ${error.message}`);
                        if (currentApproach < tryConversions.length) {
                            tryNext();
                        } else {
                            reject(error);
                        }
                    })
                    .run();
            };
            
            tryNext();
        });
    }

    cleanupTempFiles(tempDir) {
        try {
            if (fs.existsSync(tempDir)) {
                const files = fs.readdirSync(tempDir);
                for (const file of files) {
                    const filePath = path.join(tempDir, file);
                    fs.unlinkSync(filePath);
                }
                fs.rmdirSync(tempDir);
                logger.info(`Cleaned up temp directory: ${tempDir}`);
            }
        } catch (error) {
            logger.error(`Failed to cleanup temp directory ${tempDir}: ${error.message}`);
        }
    }

    getFileInfo(filePath) {
        if (!fs.existsSync(filePath)) {
            return null;
        }

        const stats = fs.statSync(filePath);
        return {
            path: filePath,
            size: stats.size,
            created: stats.birthtime,
            modified: stats.mtime
        };
    }
}

module.exports = new AudioProcessor();
