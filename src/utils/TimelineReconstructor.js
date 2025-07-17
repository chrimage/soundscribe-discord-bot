const fs = require('fs');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const logger = require('./logger');

class TimelineReconstructor {
    constructor() {
        // Set of valid audio formats for reconstruction
        this.validFormats = ['.pcm', '.wav', '.mp3'];
    }

    async reconstructTimeline(speechSegments, outputPath) {
        if (!speechSegments || speechSegments.length === 0) {
            throw new Error('No speech segments provided for timeline reconstruction');
        }

        logger.info(`Reconstructing timeline from ${speechSegments.length} speech segments`);

        // Sort segments by start timestamp
        const sortedSegments = speechSegments
            .filter(segment => fs.existsSync(segment.filename))
            .sort((a, b) => a.startTimestamp - b.startTimestamp);

        if (sortedSegments.length === 0) {
            throw new Error('No valid speech segment files found');
        }

        // Create timeline with silence gaps
        const timeline = this.createTimelineWithSilence(sortedSegments);
        
        // Generate the mixed audio file
        await this.generateMixedAudio(timeline, outputPath);

        return {
            outputPath,
            totalDuration: this.calculateTotalDuration(timeline),
            segmentCount: sortedSegments.length,
            timelineEvents: timeline.length
        };
    }

    createTimelineWithSilence(sortedSegments) {
        const timeline = [];
        let previousEndTime = sortedSegments[0].startTimestamp;

        for (let i = 0; i < sortedSegments.length; i++) {
            const segment = sortedSegments[i];
            
            // Add silence if there's a gap between segments
            const gapDuration = segment.startTimestamp - previousEndTime;
            if (gapDuration > 100) { // Only add silence for gaps > 100ms
                timeline.push({
                    type: 'silence',
                    duration: gapDuration,
                    startTime: previousEndTime,
                    endTime: segment.startTimestamp
                });
            }

            // Add the speech segment
            timeline.push({
                type: 'speech',
                segment: segment,
                duration: segment.duration || (segment.endTimestamp - segment.startTimestamp),
                startTime: segment.startTimestamp,
                endTime: segment.endTimestamp || (segment.startTimestamp + (segment.duration || 5000))
            });

            previousEndTime = segment.endTimestamp || (segment.startTimestamp + (segment.duration || 5000));
        }

        return timeline;
    }

    async generateMixedAudio(timeline, outputPath) {
        // Create a temporary script for FFmpeg complex filter
        const tempDir = path.dirname(outputPath);
        const scriptPath = path.join(tempDir, 'ffmpeg_script.txt');
        
        try {
            // Build FFmpeg input list and filter complex
            const { inputs, filterComplex } = this.buildFFmpegCommand(timeline);
            
            // Write filter complex to file for complex operations
            fs.writeFileSync(scriptPath, filterComplex);

            return new Promise((resolve, reject) => {
                let command = ffmpeg();

                // Add all input files
                inputs.forEach(input => {
                    if (input.type === 'file') {
                        command = command.input(input.path);
                    } else if (input.type === 'silence') {
                        // Generate silence using lavfi
                        command = command.input(`anullsrc=channel_layout=mono:sample_rate=48000:duration=${input.duration/1000}`);
                        command = command.inputFormat('lavfi');
                    }
                });

                command
                    .complexFilter(filterComplex)
                    .outputOptions([
                        '-map', '[mixed]',
                        '-ar', '48000',
                        '-ac', '1',
                        '-c:a', 'mp3',
                        '-b:a', '128k'
                    ])
                    .on('start', (commandLine) => {
                        logger.debug(`FFmpeg command: ${commandLine}`);
                    })
                    .on('progress', (progress) => {
                        if (progress.percent) {
                            logger.debug(`Timeline reconstruction progress: ${Math.round(progress.percent)}%`);
                        }
                    })
                    .on('end', () => {
                        logger.info(`Timeline reconstruction completed: ${outputPath}`);
                        // Clean up script file
                        try {
                            fs.unlinkSync(scriptPath);
                        } catch (error) {
                            logger.debug('Failed to clean up FFmpeg script file:', error);
                        }
                        resolve();
                    })
                    .on('error', (err) => {
                        logger.error('FFmpeg timeline reconstruction error:', err);
                        // Clean up script file
                        try {
                            fs.unlinkSync(scriptPath);
                        } catch (error) {
                            logger.debug('Failed to clean up FFmpeg script file during error:', error);
                        }
                        reject(err);
                    })
                    .save(outputPath);
            });

        } catch (error) {
            // Clean up script file on error
            try {
                if (fs.existsSync(scriptPath)) {
                    fs.unlinkSync(scriptPath);
                }
            } catch (cleanupError) {
                logger.debug('Failed to clean up FFmpeg script file:', cleanupError);
            }
            throw error;
        }
    }

    buildFFmpegCommand(timeline) {
        const inputs = [];
        const filterChain = [];
        let inputIndex = 0;

        for (const event of timeline) {
            if (event.type === 'speech') {
                // Convert PCM to audio format for FFmpeg
                inputs.push({
                    type: 'file',
                    path: event.segment.filename,
                    index: inputIndex
                });
                
                // Add format conversion for PCM files
                if (event.segment.filename.endsWith('.pcm')) {
                    filterChain.push(`[${inputIndex}:a]aformat=sample_fmts=s16:sample_rates=48000:channel_layouts=mono[audio${inputIndex}]`);
                } else {
                    filterChain.push(`[${inputIndex}:a]aformat=sample_fmts=s16:sample_rates=48000:channel_layouts=mono[audio${inputIndex}]`);
                }
                
                inputIndex++;
            } else if (event.type === 'silence') {
                // Generate silence
                const silenceDuration = Math.max(0.1, event.duration / 1000); // Minimum 0.1s
                inputs.push({
                    type: 'silence',
                    duration: event.duration,
                    index: inputIndex
                });
                
                filterChain.push(`[${inputIndex}:a]aformat=sample_fmts=s16:sample_rates=48000:channel_layouts=mono[audio${inputIndex}]`);
                inputIndex++;
            }
        }

        // Concatenate all audio streams
        const audioStreams = Array.from({length: inputIndex}, (_, i) => `[audio${i}]`).join('');
        filterChain.push(`${audioStreams}concat=n=${inputIndex}:v=0:a=1[mixed]`);

        return {
            inputs,
            filterComplex: filterChain.join(';')
        };
    }

    calculateTotalDuration(timeline) {
        if (timeline.length === 0) return 0;
        
        const lastEvent = timeline[timeline.length - 1];
        const firstEvent = timeline[0];
        
        return lastEvent.endTime - firstEvent.startTime;
    }

    // Utility method to add mixed audio reconstruction to existing recording flow
    async enhanceRecordingWithMixedAudio(recordingResult) {
        if (!recordingResult.speechSegments || recordingResult.speechSegments.length === 0) {
            logger.info('No speech segments available for mixed audio reconstruction');
            return recordingResult;
        }

        try {
            const mixedAudioPath = recordingResult.outputFile.replace('.mp3', '_mixed_timeline.mp3');
            
            const reconstructionResult = await this.reconstructTimeline(
                recordingResult.speechSegments,
                mixedAudioPath
            );

            return {
                ...recordingResult,
                mixedAudio: {
                    filePath: mixedAudioPath,
                    ...reconstructionResult
                }
            };

        } catch (error) {
            logger.error('Failed to create mixed audio timeline:', error);
            // Return original result without mixed audio on failure
            return recordingResult;
        }
    }
}

module.exports = new TimelineReconstructor();