const { joinVoiceChannel, VoiceConnectionStatus, EndBehaviorType } = require('@discordjs/voice');
const { pipeline } = require('stream');
const { opus } = require('prism-media');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const logger = require('../utils/logger');

class VoiceRecorder {
    constructor() {
        this.activeRecordings = new Map();
        this.client = null;
    }

    setClient(client) {
        this.client = client;
    }

    async startRecording(interaction) {
        const guildId = interaction.guild.id;
        
        if (this.activeRecordings.has(guildId)) {
            throw new Error('A recording is already in progress in this server');
        }

        const member = interaction.member;
        if (!member.voice.channel) {
            throw new Error('You must be in a voice channel to start recording');
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
                this.client.on('voiceStateUpdate', (oldState, newState) => {
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
                });
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
            throw new Error('No active recording found for this server');
        }

        logger.info(`Stopping recording in guild ${guildId}`);

        try {
            const { connection, userStreams, tempDir, outputFile } = recordingSession;

            // Stop all user streams gracefully
            const streamCleanupPromises = [];
            userStreams.forEach((streamInfo, userId) => {
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
            
            // Clean up session
            this.activeRecordings.delete(guildId);

            logger.info(`Recording stopped for guild ${guildId}, duration: ${duration}ms, files created: ${filesCreated}`);

            return {
                tempDir,
                outputFile,
                duration,
                participants: Array.from(recordingSession.participants.values()),
                filesCreated
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
        const { userStreams, tempDir, startTime } = recordingSession;

        // Subscribe to each user individually
        voiceChannel.members.forEach(member => {
            if (!member.user.bot) {
                const userId = member.id;
                const username = member.user.username;
                
                logger.info(`Setting up recording for user ${username} (${userId})`);
                
                try {
                    const audioStream = receiver.subscribe(userId, {
                        end: {
                            behavior: EndBehaviorType.Manual, // Keep stream open until manually ended
                        },
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
                    let pipelineCompleted = false;
                    let audioDataReceived = false;
                    let totalDataReceived = 0;

                    // Monitor audio stream for data
                    audioStream.on('data', (chunk) => {
                        audioDataReceived = true;
                        totalDataReceived += chunk.length;
                        logger.debug(`Audio data received for ${username}: ${chunk.length} bytes (total: ${totalDataReceived})`);
                    });

                    // Monitor decoder for data
                    decoder.on('data', (chunk) => {
                        logger.debug(`Decoded audio data for ${username}: ${chunk.length} bytes`);
                    });

                    // Set up pipeline with proper error handling
                    const pipelinePromise = new Promise((resolve, reject) => {
                        pipeline(audioStream, decoder, writeStream, (err) => {
                            pipelineCompleted = true;
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

    setupUserStream(recordingSession, userId, username, voiceChannel) {
        const { userStreams, tempDir } = recordingSession;
        const receiver = recordingSession.connection.receiver;
        
        try {
            const audioStream = receiver.subscribe(userId, {
                end: {
                    behavior: EndBehaviorType.Manual,
                },
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
}

module.exports = new VoiceRecorder();