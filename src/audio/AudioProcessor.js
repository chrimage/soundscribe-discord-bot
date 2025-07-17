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

    async processRecording(tempDir, outputFile, cleanupTempFiles = true) {
        if (!fs.existsSync(tempDir)) {
            throw new Error(`Temp directory not found: ${tempDir}`);
        }

        logger.info(`Processing recording segments from: ${tempDir} -> ${outputFile}`);

        // Get all user PCM files
        const userFiles = fs.readdirSync(tempDir)
            .filter(file => file.endsWith('.pcm'))
            .map(file => path.join(tempDir, file));

        if (userFiles.length === 0) {
            throw new Error('No audio segments found - no one spoke during recording');
        }

        // Check if files have content
        const validFiles = userFiles.filter(file => {
            const stats = fs.statSync(file);
            return stats.size > 0;
        });

        if (validFiles.length === 0) {
            throw new Error('All audio segments are empty - no audio was captured');
        }

        return new Promise((resolve, reject) => {
            const startTime = Date.now();
            
            const ffmpegCommand = ffmpeg();
            
            // Add each user file as input
            validFiles.forEach(file => {
                ffmpegCommand.input(file)
                    .inputFormat('s16le')
                    .inputOptions([
                        '-ac', '2',
                        '-ar', '48000'
                    ]);
            });

            // Mix all inputs together
            const filterComplex = validFiles.length > 1 
                ? `amix=inputs=${validFiles.length}:duration=longest:dropout_transition=0`
                : null;

            if (filterComplex) {
                ffmpegCommand.complexFilter(filterComplex);
            }

            ffmpegCommand
                .audioCodec('libmp3lame')
                .audioBitrate(config.audio.quality)
                .on('start', (commandLine) => {
                    logger.debug(`FFmpeg processing started`);
                })
                .on('end', () => {
                    const processingTime = Date.now() - startTime;
                    logger.info(`Processing completed in ${processingTime}ms`);
                    
                    // Get file size
                    const stats = fs.statSync(outputFile);
                    const fileSize = stats.size;
                    
                    // Clean up temp files (if requested)
                    if (cleanupTempFiles) {
                        this.cleanupTempFiles(tempDir);
                    }
                    
                    resolve({
                        outputFile,
                        processingTime,
                        fileSize,
                        segmentCount: validFiles.length
                    });
                })
                .on('error', (err) => {
                    logger.error('FFmpeg processing error:', err);
                    reject(new Error(`Audio processing failed: ${err.message}`));
                })
                .save(outputFile);
        });
    }

    async validateFFmpeg() {
        return new Promise((resolve, reject) => {
            ffmpeg.getAvailableFormats((err, formats) => {
                if (err) {
                    logger.error('FFmpeg validation failed:', err);
                    reject(err);
                } else {
                    logger.info('FFmpeg validation successful');
                    logger.debug('Available formats:', Object.keys(formats).slice(0, 10));
                    resolve(true);
                }
            });
        });
    }

    async testProcessingPerformance(durationMinutes = 1) {
        logger.info(`Testing processing performance for ${durationMinutes} minute recording`);
        
        // Create a test PCM file with silence
        const testInput = path.join(config.paths.temp, `test_${durationMinutes}min.pcm`);
        const testOutput = path.join(config.paths.recordings, `test_${durationMinutes}min.mp3`);
        
        try {
            // Generate test PCM data (silence)
            const sampleRate = 48000;
            const channels = 2;
            const bytesPerSample = 2;
            const totalSamples = sampleRate * durationMinutes * 60;
            const bufferSize = totalSamples * channels * bytesPerSample;
            
            const silence = Buffer.alloc(bufferSize, 0);
            fs.writeFileSync(testInput, silence);
            
            const startTime = Date.now();
            const result = await this.processRecording(testInput, testOutput);
            const totalTime = Date.now() - startTime;
            
            logger.info(`Performance test completed: ${durationMinutes}min recording processed in ${totalTime}ms`);
            
            // Clean up test files
            if (fs.existsSync(testOutput)) {
                fs.unlinkSync(testOutput);
            }
            
            return {
                durationMinutes,
                processingTimeMs: totalTime,
                ratio: totalTime / (durationMinutes * 60 * 1000)
            };
            
        } catch (error) {
            logger.error('Performance test failed:', error);
            throw error;
        }
    }

    cleanupTempFiles(tempDir) {
        try {
            if (fs.existsSync(tempDir)) {
                const files = fs.readdirSync(tempDir);
                files.forEach(file => {
                    const filePath = path.join(tempDir, file);
                    fs.unlinkSync(filePath);
                    logger.debug(`Cleaned up temp file: ${filePath}`);
                });
                fs.rmdirSync(tempDir);
                logger.info(`Cleaned up temp directory: ${tempDir}`);
            }
        } catch (error) {
            logger.error('Error cleaning up temp files:', error);
        }
    }

}

module.exports = new AudioProcessor();