const { joinVoiceChannel, VoiceConnectionStatus, EndBehaviorType } = require('@discordjs/voice');
const { pipeline } = require('stream');
const { opus } = require('prism-media');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const logger = require('../utils/logger');
const { RECORDING, ERROR_MESSAGES, _SUCCESS_MESSAGES } = require('../constants');

class VoiceRecorder {
    constructor() {
        this.activeRecordings = new Map();
        this.client = null;
        this.speakingHandlers = new Map(); // Track speaking event handlers per guild
    }

    setClient(client) {
        this.client = client;
    }

    async startRecording(interaction) {
        const guildId = interaction.guild.id;

        if (this.activeRecordings.has(guildId)) {
            throw new Error(ERROR_MESSAGES.RECORDING.ALREADY_RECORDING);
        }

        const member = interaction.member;
        if (!member.voice.channel) {
            throw new Error(ERROR_MESSAGES.RECORDING.NOT_IN_VOICE);
        }

        const voiceChannel = member.voice.channel;

        logger.info(`Starting recording in guild ${guildId}, channel ${voiceChannel.name}`);

        try {
            const connection = joinVoiceChannel({
                channelId: voiceChannel.id,
                guildId: guildId,
                adapterCreator: interaction.guild.voiceAdapterCreator,
                selfDeaf: false,
                selfMute: true
            });

            const sessionId = `recording_${guildId}_${Date.now()}`;
            const recordingSession = {
                connection,
                startTime: Date.now(),
                sessionId,
                participants: new Map(), // Map of userId -> participant info
                userStreams: new Map(), // Map of userId -> stream info
                speechSegments: [], // Array of speech segment metadata
                currentSpeechSegments: new Map(), // Map of userId -> current active segment
                segmentEndTimers: new Map(), // Map of userId -> timeout for delayed segment ending
                tempDir: path.join(config.paths.temp, sessionId),
                outputFile: path.join(config.paths.recordings, `${sessionId}.mp3`)
            };

            // Create directories
            if (!fs.existsSync(config.paths.temp)) {
                fs.mkdirSync(config.paths.temp, { recursive: true });
            }
            if (!fs.existsSync(config.paths.recordings)) {
                fs.mkdirSync(config.paths.recordings, { recursive: true });
            }
            if (!fs.existsSync(recordingSession.tempDir)) {
                fs.mkdirSync(recordingSession.tempDir, { recursive: true });
            }

            // Set up individual user recording
            const receiver = connection.receiver;
            this.setupUserRecording(recordingSession, receiver, voiceChannel);

            // Set up speaking event handlers for speech segmentation
            this.setupSpeakingEvents(recordingSession, voiceChannel);

            // Handle connection state changes
            connection.on(VoiceConnectionStatus.Disconnected, () => {
                logger.warn(`Voice connection disconnected for guild ${guildId}`);
            });

            connection.on(VoiceConnectionStatus.Destroyed, () => {
                logger.warn(`Voice connection destroyed for guild ${guildId}`);
            });

            // Track initial participants
            voiceChannel.members.forEach(member => {
                if (!member.user.bot) {
                    recordingSession.participants.set(member.id, {
                        username: member.user.username,
                        displayName: member.displayName,
                        joinTime: Date.now()
                    });
                }
            });

            // Handle users joining/leaving during recording
            if (this.client) {
                const voiceStateHandler = (oldState, newState) => {
                    if (this.activeRecordings.has(guildId)) {
                        const recordingSession = this.activeRecordings.get(guildId);

                        // User joined the recording channel
                        if (newState.channelId === voiceChannel.id && !newState.member.user.bot) {
                            const userId = newState.member.id;
                            const username = newState.member.user.username;

                            if (!recordingSession.participants.has(userId)) {
                                logger.info(`User ${username} joined recording`);
                                recordingSession.participants.set(userId, {
                                    username: username,
                                    displayName: newState.member.displayName,
                                    joinTime: Date.now()
                                });

                                // Set up recording for the new user
                                this.setupUserStream(recordingSession, userId, username, voiceChannel);
                            }
                        }

                        // User left the recording channel
                        if (oldState.channelId === voiceChannel.id && !oldState.member.user.bot) {
                            const userId = oldState.member.id;
                            const username = oldState.member.user.username;

                            if (recordingSession.participants.has(userId)) {
                                logger.info(`User ${username} left recording`);
                                recordingSession.participants.get(userId).leaveTime = Date.now();

                                // End the user's stream
                                const streamInfo = recordingSession.userStreams.get(userId);
                                if (streamInfo && streamInfo.audioStream) {
                                    streamInfo.audioStream.destroy();
                                }
                            }
                        }
                    }
                };

                this.client.on('voiceStateUpdate', voiceStateHandler);
                recordingSession.voiceStateHandler = voiceStateHandler; // Store for cleanup
            }

            this.activeRecordings.set(guildId, recordingSession);

            logger.info(`Recording started successfully in guild ${guildId}`);
            return recordingSession;

        } catch (error) {
            logger.error('Failed to start recording:', error);
            throw error;
        }
    }

    async stopRecording(guildId) {
        const recordingSession = this.activeRecordings.get(guildId);
        if (!recordingSession) {
            throw new Error(ERROR_MESSAGES.RECORDING.NO_ACTIVE_RECORDING);
        }

        logger.info(`Stopping recording in guild ${guildId}`);

        try {
            const { connection, userStreams, tempDir, outputFile } = recordingSession;

            // Clean up any pending segment end timers
            if (recordingSession.segmentEndTimers) {
                recordingSession.segmentEndTimers.forEach((timer, userId) => {
                    clearTimeout(timer);
                    logger.debug(`Cleared pending segment end timer for user ${userId}`);
                });
                recordingSession.segmentEndTimers.clear();
            }

            // Stop all user streams gracefully
            const streamCleanupPromises = [];
            userStreams.forEach((streamInfo, _userId) => {
                logger.info(`Cleaning up stream for user ${streamInfo.username}`);

                try {
                    // Mark stream as ended to prevent further writes
                    streamInfo.streamEnded = true;

                    // Close the audio stream first
                    if (streamInfo.audioStream && !streamInfo.audioStream.destroyed) {
                        streamInfo.audioStream.destroy();
                    }

                    // Close the decoder
                    if (streamInfo.decoder && !streamInfo.decoder.destroyed) {
                        streamInfo.decoder.destroy();
                    }

                    // Close the write stream
                    if (streamInfo.writeStream && !streamInfo.writeStream.destroyed) {
                        streamInfo.writeStream.end();
                        streamCleanupPromises.push(
                            new Promise((resolve) => {
                                streamInfo.writeStream.on('finish', resolve);
                                streamInfo.writeStream.on('error', resolve); // Resolve on error too
                                // Add timeout to prevent hanging
                                setTimeout(resolve, 5000);
                            })
                        );
                    }

                    // Also wait for pipeline to complete if it exists
                    if (streamInfo.pipelinePromise) {
                        streamCleanupPromises.push(
                            streamInfo.pipelinePromise.catch(() => {}) // Ignore pipeline errors during cleanup
                        );
                    }
                } catch (error) {
                    logger.error(`Error cleaning up stream for user ${streamInfo.username}:`, error);
                }
            });

            // Wait for all streams to finish with timeout
            await Promise.allSettled(streamCleanupPromises);

            // Disconnect from voice channel
            connection.destroy();

            // Additional wait to ensure all file writes are complete
            logger.info('Waiting for file writes to complete...');
            await new Promise(resolve => setTimeout(resolve, 2000));

            // Check if any PCM files were actually created
            let filesCreated = 0;
            if (fs.existsSync(tempDir)) {
                const files = fs.readdirSync(tempDir);
                filesCreated = files.filter(f => f.endsWith('.pcm')).length;
                logger.info(`Found ${filesCreated} PCM files in temp directory`);

                // Log file sizes for debugging
                files.forEach(file => {
                    const filePath = path.join(tempDir, file);
                    const stats = fs.statSync(filePath);
                    logger.info(`File ${file}: ${stats.size} bytes`);
                });
            }

            // Calculate recording duration
            const duration = Date.now() - recordingSession.startTime;

            // Wait briefly for final speaking events to be processed
            await new Promise(resolve => setTimeout(resolve, 500));

            // Clean up event handlers
            this.cleanupSpeakingEvents(guildId);
            this.cleanupVoiceStateHandler(recordingSession);

            // Clean up session
            this.activeRecordings.delete(guildId);

            logger.info(`Recording stopped for guild ${guildId}, duration: ${duration}ms, files created: ${filesCreated}`);

            return {
                tempDir,
                outputFile,
                duration,
                participants: Array.from(recordingSession.participants.values()),
                filesCreated,
                speechSegments: recordingSession.speechSegments
            };

        } catch (error) {
            logger.error('Failed to stop recording:', error);
            throw error;
        }
    }

    getActiveRecording(guildId) {
        return this.activeRecordings.get(guildId);
    }

    getAllActiveRecordings() {
        return Array.from(this.activeRecordings.keys());
    }

    isRecordingActive(guildId) {
        return this.activeRecordings.has(guildId);
    }

    setupUserRecording(recordingSession, receiver, voiceChannel) {
        const { userStreams, tempDir, _startTime } = recordingSession;

        // Subscribe to each user individually
        voiceChannel.members.forEach(member => {
            if (!member.user.bot) {
                const userId = member.id;
                const username = member.user.username;

                logger.info(`Setting up recording for user ${username} (${userId})`);

                try {
                    const audioStream = receiver.subscribe(userId, {
                        end: {
                            behavior: EndBehaviorType.Manual // Keep stream open until manually ended
                        }
                    });

                    logger.info(`Audio stream created for user ${username}`);

                    const decoder = new opus.Decoder({
                        rate: 48000,
                        channels: 2,
                        frameSize: 960
                    });

                    const userFile = path.join(tempDir, `user_${userId}_${username}.pcm`);
                    const writeStream = fs.createWriteStream(userFile);

                    // Track stream state and data
                    let streamEnded = false;
                    let _pipelineCompleted = false;
                    let audioDataReceived = false;
                    let totalDataReceived = 0;

                    // Monitor audio stream for data (throttled logging)
                    let lastLogTime = 0;
                    audioStream.on('data', (chunk) => {
                        audioDataReceived = true;
                        totalDataReceived += chunk.length;

                        // Throttle logging to avoid spam
                        const now = Date.now();
                        if (now - lastLogTime > 1000) { // Log once per second max
                            logger.debug(`Audio data received for ${username}: ${chunk.length} bytes (total: ${totalDataReceived})`);
                            lastLogTime = now;
                        }
                    });

                    // Monitor decoder for data
                    decoder.on('data', (chunk) => {
                        logger.debug(`Decoded audio data for ${username}: ${chunk.length} bytes`);
                    });

                    // Set up pipeline with proper error handling
                    const pipelinePromise = new Promise((resolve, reject) => {
                        pipeline(audioStream, decoder, writeStream, (err) => {
                            _pipelineCompleted = true;
                            logger.info(`Pipeline completed for user ${username}. Audio received: ${audioDataReceived}, Total bytes: ${totalDataReceived}`);
                            if (err && !streamEnded) {
                                logger.error(`Pipeline failed for user ${username}:`, err);
                                reject(err);
                            } else {
                                logger.info(`Recording pipeline completed for user ${username}`);
                                resolve();
                            }
                        });
                    });

                    userStreams.set(userId, {
                        audioStream,
                        decoder,
                        writeStream,
                        userFile,
                        username,
                        pipelinePromise,
                        streamEnded: false
                    });

                    // Handle individual stream events
                    audioStream.on('error', (error) => {
                        logger.error(`Audio stream error for user ${username}:`, error);
                        streamEnded = true;
                        if (!writeStream.destroyed) {
                            writeStream.destroy();
                        }
                    });

                    audioStream.on('end', () => {
                        streamEnded = true;
                        if (userStreams.has(userId)) {
                            userStreams.get(userId).streamEnded = true;
                        }
                    });

                    // Handle decoder errors
                    decoder.on('error', (error) => {
                        logger.error(`Decoder error for user ${username}:`, error);
                        streamEnded = true;
                        if (!writeStream.destroyed) {
                            writeStream.destroy();
                        }
                    });

                    // Handle write stream errors
                    writeStream.on('error', (error) => {
                        logger.error(`Write stream error for user ${username}:`, error);
                        streamEnded = true;
                    });

                } catch (error) {
                    logger.error(`Failed to set up recording for user ${username}:`, {
                        error: error.message,
                        stack: error.stack,
                        code: error.code
                    });
                }
            }
        });

        // Handle voice state changes (users joining/leaving)
        recordingSession.connection.on('stateChange', (oldState, newState) => {
            logger.debug(`Voice connection state changed: ${oldState.status} -> ${newState.status}`);
        });
    }

    setupUserStream(recordingSession, userId, username, _voiceChannel) {
        const { userStreams, tempDir } = recordingSession;
        const receiver = recordingSession.connection.receiver;

        try {
            const audioStream = receiver.subscribe(userId, {
                end: {
                    behavior: EndBehaviorType.Manual
                }
            });

            const decoder = new opus.Decoder({
                rate: 48000,
                channels: 2,
                frameSize: 960
            });

            const userFile = path.join(tempDir, `user_${userId}_${username}.pcm`);
            const writeStream = fs.createWriteStream(userFile);

            // Set up pipeline
            const pipelinePromise = new Promise((resolve, reject) => {
                pipeline(audioStream, decoder, writeStream, (err) => {
                    if (err) {
                        logger.error(`Pipeline failed for user ${username}:`, err);
                        reject(err);
                    } else {
                        resolve();
                    }
                });
            });

            userStreams.set(userId, {
                audioStream,
                decoder,
                writeStream,
                userFile,
                username,
                pipelinePromise,
                streamEnded: false
            });

            // Handle stream errors
            audioStream.on('error', (error) => {
                logger.error(`Audio stream error for user ${username}:`, error);
                if (!writeStream.destroyed) {
                    writeStream.destroy();
                }
            });

            audioStream.on('end', () => {
                if (userStreams.has(userId)) {
                    userStreams.get(userId).streamEnded = true;
                }
            });

            decoder.on('error', (error) => {
                logger.error(`Decoder error for user ${username}:`, error);
                if (!writeStream.destroyed) {
                    writeStream.destroy();
                }
            });

            writeStream.on('error', (error) => {
                logger.error(`Write stream error for user ${username}:`, error);
            });

        } catch (error) {
            logger.error(`Failed to set up recording for user ${username}:`, error);
        }
    }

    setupSpeakingEvents(recordingSession, voiceChannel) {
        const guildId = voiceChannel.guild.id;
        const receiver = recordingSession.connection.receiver;

        try {
            // Set up speaking event handler with error handling
            const speakingHandler = (userId, speaking) => {
                try {
                    // Only process events for users in our recording channel
                    const member = voiceChannel.members.get(userId);
                    if (!member || member.user.bot) {
                        return;
                    }

                    const isCurrentlySpeaking = speaking && speaking.bitfield !== 0;
                    const timestamp = Date.now();

                    logger.debug(`Speaking event for ${member.user.username}: ${isCurrentlySpeaking ? 'started' : 'stopped'}`);

                    if (isCurrentlySpeaking) {
                        this.handleSpeechStart(recordingSession, userId, member.user.username, member.displayName, timestamp);
                    } else {
                        this.handleSpeechStop(recordingSession, userId, timestamp);
                    }
                } catch (error) {
                    logger.error(`Error in speaking event handler for user ${userId}:`, error);
                }
            };

            // Store the handler for cleanup
            this.speakingHandlers.set(guildId, speakingHandler);

            // Listen for speaking events with error handling
            // Correct Discord.js v14 API: receiver.speaking.on('start'/'end')
            try {
                receiver.speaking.on('start', (userId) => {
                    try {
                        speakingHandler(userId, { bitfield: 1 });
                    } catch (error) {
                        logger.error('Error in speaking start handler:', error);
                    }
                });

                receiver.speaking.on('end', (userId) => {
                    try {
                        speakingHandler(userId, { bitfield: 0 });
                    } catch (error) {
                        logger.error('Error in speaking end handler:', error);
                    }
                });

                logger.info(`Set up speaking event listeners for guild ${guildId}`);

            } catch (error) {
                logger.error('Failed to set up speaking event listeners:', error);
                // Continue without speaking events - fallback to continuous recording
            }

        } catch (error) {
            logger.error('Failed to setup speaking events:', error);
            // Continue without speaking events
        }
    }

    handleSpeechStart(recordingSession, userId, username, displayName, timestamp) {
        const { segmentEndTimers } = recordingSession;

        // Cancel any pending segment end timer for this user
        if (segmentEndTimers.has(userId)) {
            clearTimeout(segmentEndTimers.get(userId));
            segmentEndTimers.delete(userId);
            logger.debug(`Cancelled pending segment end for ${username} - continuing existing segment`);
            return; // Continue existing segment instead of starting new one
        }

        // Start new segment
        this.startSpeechSegment(recordingSession, userId, username, displayName, timestamp);
    }

    handleSpeechStop(recordingSession, userId, timestamp) {
        const { currentSpeechSegments, segmentEndTimers } = recordingSession;

        // Only handle if user has an active segment
        if (!currentSpeechSegments.has(userId)) {
            return;
        }

        const segment = currentSpeechSegments.get(userId);
        const username = segment.username;

        // Set a delay timer before actually ending the segment
        // This allows for brief pauses between words/sentences
        const SEGMENT_END_DELAY = RECORDING.SEGMENT_END_DELAY_MS;

        const timer = setTimeout(() => {
            logger.debug(`Segment end timer expired for ${username} - ending segment`);
            segmentEndTimers.delete(userId);
            this.endSpeechSegment(recordingSession, userId, timestamp);
        }, SEGMENT_END_DELAY);

        segmentEndTimers.set(userId, timer);
        logger.debug(`Set ${SEGMENT_END_DELAY}ms delay timer for ending ${username}'s segment`);
    }

    startSpeechSegment(recordingSession, userId, username, displayName, timestamp) {
        try {
            const { currentSpeechSegments, tempDir } = recordingSession;

            // If user is already speaking, ignore (shouldn't happen normally)
            if (currentSpeechSegments.has(userId)) {
                logger.warn(`User ${username} started speaking but already has active segment`);
                return;
            }

            const segmentId = `segment_${userId}_${timestamp}`;
            const segmentFile = path.join(tempDir, `${segmentId}.pcm`);

            const segment = {
                segmentId,
                userId,
                username,
                displayName,
                startTimestamp: timestamp,
                endTimestamp: null,
                duration: null,
                filename: segmentFile,
                writeStream: null,
                audioStream: null,
                decoder: null
            };

            // Create audio recording pipeline for this segment
            try {
                const receiver = recordingSession.connection.receiver;
                const audioStream = receiver.subscribe(userId, {
                    end: { behavior: EndBehaviorType.Manual }
                });

                const decoder = new opus.Decoder({
                    rate: 48000,
                    channels: 2,
                    frameSize: 960
                });

                const writeStream = fs.createWriteStream(segmentFile);

                // Set up pipeline with additional error handling
                pipeline(audioStream, decoder, writeStream, (err) => {
                    if (err && !segment.ended) {
                        logger.error(`Pipeline failed for segment ${segmentId}:`, err);
                    }
                });

                // Add error handlers for individual streams
                audioStream.on('error', (error) => {
                    logger.error(`Audio stream error for segment ${segmentId}:`, error);
                });

                decoder.on('error', (error) => {
                    logger.error(`Decoder error for segment ${segmentId}:`, error);
                });

                writeStream.on('error', (error) => {
                    logger.error(`Write stream error for segment ${segmentId}:`, error);
                });

                segment.audioStream = audioStream;
                segment.decoder = decoder;
                segment.writeStream = writeStream;

                currentSpeechSegments.set(userId, segment);

                logger.info(`Started speech segment for ${username}: ${segmentId}`);

            } catch (error) {
                logger.error(`Failed to create audio pipeline for speech segment ${segmentId}:`, error);
            }

        } catch (error) {
            logger.error(`Failed to start speech segment for user ${userId}:`, error);
        }
    }

    endSpeechSegment(recordingSession, userId, timestamp) {
        const { currentSpeechSegments, speechSegments } = recordingSession;

        const segment = currentSpeechSegments.get(userId);
        if (!segment) {
            // User wasn't speaking, ignore
            return;
        }

        // Mark segment as ended
        segment.ended = true;
        segment.endTimestamp = timestamp;
        segment.duration = timestamp - segment.startTimestamp;

        // Clean up streams
        try {
            if (segment.audioStream && !segment.audioStream.destroyed) {
                segment.audioStream.destroy();
            }
            if (segment.decoder && !segment.decoder.destroyed) {
                segment.decoder.destroy();
            }
            if (segment.writeStream && !segment.writeStream.destroyed) {
                segment.writeStream.end();
            }
        } catch (error) {
            logger.error(`Error cleaning up segment ${segment.segmentId}:`, error);
        }

        // Remove from active segments and add to completed segments
        currentSpeechSegments.delete(userId);

        // Only add segments that had meaningful duration (> 4000ms for better transcription)
        if (segment.duration > 4000) {
            speechSegments.push({
                segmentId: segment.segmentId,
                userId: segment.userId,
                username: segment.username,
                displayName: segment.displayName,
                startTimestamp: segment.startTimestamp,
                endTimestamp: segment.endTimestamp,
                duration: segment.duration,
                filename: segment.filename
            });

            logger.info(`Ended speech segment for ${segment.username}: ${segment.segmentId} (${segment.duration}ms)`);
        } else {
            // Clean up very short segments
            try {
                if (fs.existsSync(segment.filename)) {
                    fs.unlinkSync(segment.filename);
                }
            } catch (error) {
                logger.error('Failed to clean up short segment file:', error);
            }
            logger.debug(`Discarded short speech segment for ${segment.username}: ${segment.duration}ms (minimum: ${RECORDING.MIN_SEGMENT_DURATION_MS}ms)`);
        }
    }

    cleanupSpeakingEvents(guildId) {
        // Remove speaking event handler
        if (this.speakingHandlers.has(guildId)) {
            // Note: Discord.js doesn't provide a clean way to remove specific handlers
            // The handlers will be cleaned up when the connection is destroyed
            this.speakingHandlers.delete(guildId);
        }
    }

    cleanupVoiceStateHandler(recordingSession) {
        // Remove voice state update handler to prevent memory leaks
        if (this.client && recordingSession.voiceStateHandler) {
            this.client.removeListener('voiceStateUpdate', recordingSession.voiceStateHandler);
            logger.debug('Cleaned up voice state update handler');
        }
    }
}

module.exports = new VoiceRecorder();
