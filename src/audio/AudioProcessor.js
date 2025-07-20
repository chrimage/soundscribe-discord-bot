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
            // Generate output filenames
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const wavFile = path.join(config.paths.temp, `temp_${timestamp}.wav`);
            const mp3File = path.join(config.paths.recordings, `recording_${timestamp}.mp3`);

            // Step 1: PCM → WAV (intermediate format)
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

                logger.info(`Processing single PCM file: ${userFile.filepath} (${Math.round(pcmStats.size / 1024)}KB)`);
                await this.convertPcmToWav(userFile.filepath, wavFile);
            } else {
                logger.info(`Mixing ${userFiles.length} PCM files`);
                await this.mixPcmToWav(userFiles, wavFile);
            }

            // Step 2: WAV → MP3 (final compressed format)
            await this.convertWavToMp3(wavFile, mp3File);

            // Cleanup intermediate WAV file
            if (fs.existsSync(wavFile)) {
                fs.unlinkSync(wavFile);
            }

            const stats = fs.statSync(mp3File);
            logger.info(`Created final recording: ${mp3File} (${Math.round(stats.size / 1024)}KB)`);

            return {
                outputFile: mp3File,
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

    async convertWavToMp3(wavFilePath, outputPath) {
        // Convert WAV to compressed MP3 format (final step)
        return new Promise((resolve, reject) => {
            ffmpeg()
                .input(wavFilePath)
                .audioCodec('libmp3lame')
                .audioBitrate(config.audio.quality || '192k')
                .audioFrequency(48000)
                .audioChannels(2)
                .format('mp3')
                .output(outputPath)
                .on('end', () => {
                    logger.debug(`Converted WAV to MP3: ${path.basename(outputPath)}`);
                    resolve();
                })
                .on('error', (error) => {
                    logger.error(`WAV to MP3 conversion failed: ${error.message}`);
                    reject(error);
                })
                .run();
        });
    }

    async mixPcmToWav(userFiles, outputPath) {
        // Mix multiple PCM files into a single WAV file (intermediate step)
        return new Promise((resolve, reject) => {
            const command = ffmpeg();

            // Add each user's PCM file as input with Discord format
            for (const userFile of userFiles) {
                command.input(userFile.filepath)
                    .inputFormat('s16le')
                    .inputOptions(['-ar', '48000', '-ac', '2']);  // STEREO Discord format
            }

            // Create amix filter for combining all inputs
            const filterChain = userFiles.length > 1
                ? `amix=inputs=${userFiles.length}:duration=longest:dropout_transition=0`
                : 'anull';

            command
                .complexFilter([filterChain])
                .audioCodec('pcm_s16le')
                .audioFrequency(48000)
                .audioChannels(2)
                .format('wav')
                .output(outputPath)
                .on('end', () => {
                    logger.debug(`Mixed ${userFiles.length} PCM streams into WAV: ${path.basename(outputPath)}`);
                    resolve();
                })
                .on('error', (error) => {
                    logger.error(`PCM to WAV mixing failed: ${error.message}`);
                    reject(error);
                })
                .run();
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
