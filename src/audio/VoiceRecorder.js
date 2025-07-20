const { joinVoiceChannel, VoiceConnectionStatus, EndBehaviorType } = require('@discordjs/voice');
const { pipeline } = require('stream');
const { opus } = require('prism-media');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const logger = require('../utils/logger');

class VoiceRecorder {
    constructor() {
        this.connections = new Map(); // guildId -> connection info
        this.recordings = new Map(); // guildId -> recording data
        this.client = null;
    }

    setClient(client) {
        this.client = client;
    }

    async startRecording(interaction) {
        const voiceChannel = interaction.member.voice.channel;
        if (!voiceChannel) {
            throw new Error('User is not in a voice channel');
        }

        return await this.joinChannel(voiceChannel);
    }

    async joinChannel(channel, retryCount = 0) {
        const guildId = channel.guild.id;

        if (this.connections.has(guildId)) {
            logger.warn(`Already connected to voice channel in guild ${guildId}`);
            return false;
        }

        try {
            logger.info(`Attempting to join voice channel ${channel.name} (${channel.id}) in guild ${guildId} (attempt ${retryCount + 1})`);
            const connection = joinVoiceChannel({
                channelId: channel.id,
                guildId: guildId,
                adapterCreator: channel.guild.voiceAdapterCreator,
                selfDeaf: false,
                selfMute: true
            });
            logger.info(`Voice connection object created for guild ${guildId}`);

            // Wait for connection to be ready with detailed logging
            await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    logger.error(`Voice connection timeout after 15 seconds. Current status: ${connection.state.status}`);
                    reject(new Error('Voice connection timeout - Discord voice servers may be unavailable'));
                }, 15000);

                connection.on(VoiceConnectionStatus.Ready, () => {
                    logger.info(`Voice connection ready for guild ${guildId}`);
                    clearTimeout(timeout);
                    resolve();
                });

                connection.on(VoiceConnectionStatus.Connecting, () => {
                    logger.info(`Voice connection connecting for guild ${guildId}`);
                });

                connection.on(VoiceConnectionStatus.Disconnected, () => {
                    logger.error(`Voice connection disconnected for guild ${guildId}`);
                    clearTimeout(timeout);
                    reject(new Error('Connection failed - disconnected'));
                });

                connection.on(VoiceConnectionStatus.Destroyed, () => {
                    logger.error(`Voice connection destroyed for guild ${guildId}`);
                    clearTimeout(timeout);
                    reject(new Error('Connection failed - destroyed'));
                });

                logger.info(`Waiting for voice connection to be ready. Initial status: ${connection.state.status}`);
            });

            // Start recording setup
            const recordingData = {
                guildId,
                channelId: channel.id,
                startTime: Date.now(),
                participants: new Map(), // userId -> user info
                speakingEvents: [], // timeline of speaking events
                userStreams: new Map(), // userId -> write stream
                tempDir: path.join(config.paths.recordings, `temp_${guildId}_${Date.now()}`)
            };

            // Create temp directory
            if (!fs.existsSync(recordingData.tempDir)) {
                fs.mkdirSync(recordingData.tempDir, { recursive: true });
            }

            // Set up audio receiver
            const receiver = connection.receiver;

            // Track speaking events
            receiver.speaking.on('start', (userId) => {
                const timestamp = Date.now();
                recordingData.speakingEvents.push({
                    userId,
                    event: 'start',
                    timestamp
                });
                logger.debug(`User ${userId} started speaking at ${timestamp}`);
            });

            receiver.speaking.on('end', (userId) => {
                const timestamp = Date.now();
                recordingData.speakingEvents.push({
                    userId,
                    event: 'end',
                    timestamp
                });
                logger.debug(`User ${userId} stopped speaking at ${timestamp}`);
            });

            // Set up per-user audio streams
            channel.members.forEach(member => {
                if (member.user.bot) {
                    return;
                }

                const userId = member.user.id;
                const username = member.user.username;
                const displayName = member.displayName || username;

                recordingData.participants.set(userId, {
                    id: userId,
                    username,
                    displayName
                });

                // Use the ORIGINAL WORKING approach: Opus with decoder pipeline
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

                // Create file stream for this user
                const filename = `${userId}_${username}.pcm`;
                const filepath = path.join(recordingData.tempDir, filename);
                const writeStream = fs.createWriteStream(filepath);

                // Use the ORIGINAL WORKING pipeline: audioStream -> opus decoder -> file
                pipeline(audioStream, decoder, writeStream, (err) => {
                    if (err) {
                        logger.error(`Pipeline failed for user ${username}:`, err);
                    } else {
                        logger.debug(`Pipeline ended for user ${username}`);
                    }
                });

                recordingData.userStreams.set(userId, {
                    audioStream,
                    decoder,
                    writeStream,
                    filepath,
                    filename
                });

                logger.info(`Started recording for user ${username} (${userId})`);
            });

            this.connections.set(guildId, connection);
            this.recordings.set(guildId, recordingData);

            logger.info(`Started recording in guild ${guildId}, channel ${channel.name}`);
            return true;

        } catch (error) {
            logger.error(`Failed to join voice channel (attempt ${retryCount + 1}): ${error.message}`);

            // Retry up to 2 times if connection fails
            if (retryCount < 2 && error.message.includes('timeout')) {
                logger.info('Retrying voice connection in 2 seconds...');
                await new Promise(resolve => setTimeout(resolve, 2000));
                return this.joinChannel(channel, retryCount + 1);
            }

            throw error;
        }
    }

    async stopRecording(guildId) {
        const recordingData = this.recordings.get(guildId);
        const connection = this.connections.get(guildId);

        if (!recordingData || !connection) {
            throw new Error('No active recording found');
        }

        try {
            const endTime = Date.now();
            const duration = endTime - recordingData.startTime;

            // Stop all user streams immediately - don't wait
            for (const [userId, streamData] of recordingData.userStreams) {
                try {
                    // Aggressively close everything
                    streamData.audioStream.destroy();
                    streamData.writeStream.end();
                    if (streamData.decoder) {
                        streamData.decoder.destroy();
                    }
                } catch (error) {
                    logger.warn(`Error closing stream for user ${userId}: ${error.message}`);
                }
            }

            // Very short delay to let files finish writing
            await new Promise(resolve => setTimeout(resolve, 100));

            // Check what files were created
            for (const [userId, streamData] of recordingData.userStreams) {
                if (fs.existsSync(streamData.filepath)) {
                    const stats = fs.statSync(streamData.filepath);
                    logger.info(`Stream file: ${streamData.filepath} (${stats.size} bytes)`);
                } else {
                    logger.warn(`Stream file not created: ${streamData.filepath}`);
                }
            }

            // Disconnect from voice channel
            connection.destroy();
            this.connections.delete(guildId);

            // Process speaking events into speech segments
            const speechSegments = this.processSpeakingEvents(recordingData);

            // Create final recording result
            const result = {
                guildId,
                duration,
                startTime: recordingData.startTime,
                endTime,
                tempDir: recordingData.tempDir,
                participants: Array.from(recordingData.participants.values()),
                speechSegments,
                userFiles: this.getUserFiles(recordingData)
            };

            this.recordings.delete(guildId);
            logger.info(`Stopped recording in guild ${guildId}. Duration: ${Math.round(duration/1000)}s`);

            return result;

        } catch (error) {
            logger.error(`Error stopping recording: ${error.message}`);
            throw error;
        }
    }

    processSpeakingEvents(recordingData) {
        const rawSegments = this.generateRawSpeechSegments(recordingData);
        const consolidatedSegments = this.consolidateSpeechSegments(rawSegments, recordingData.startTime);

        logger.info(`Processed ${consolidatedSegments.length} final segments from ${rawSegments.length} raw segments.`);
        return consolidatedSegments;
    }

    generateRawSpeechSegments(recordingData) {
        const segments = [];
        const userSpeakingState = new Map(); // userId -> start timestamp

        for (const event of recordingData.speakingEvents) {
            const { userId, event: eventType, timestamp } = event;
            const participant = recordingData.participants.get(userId);

            if (!participant) {
                continue;
            }

            if (eventType === 'start') {
                if (!userSpeakingState.has(userId)) {
                    userSpeakingState.set(userId, timestamp);
                }
            } else if (eventType === 'end') {
                const startTime = userSpeakingState.get(userId);
                if (startTime) {
                    segments.push({
                        userId,
                        username: participant.username,
                        displayName: participant.displayName,
                        startTime,
                        endTime: timestamp
                    });
                    userSpeakingState.delete(userId);
                }
            }
        }

        // Sort segments by start time for chronological order
        segments.sort((a, b) => a.startTime - b.startTime);
        return segments;
    }

    consolidateSpeechSegments(rawSegments, recordingStartTime) {
        if (rawSegments.length === 0) {
            return [];
        }

        const consolidated = [];
        let currentSegment = { ...rawSegments[0] };

        for (let i = 1; i < rawSegments.length; i++) {
            const nextSegment = rawSegments[i];
            const timeBetween = nextSegment.startTime - currentSegment.endTime;

            // Merge if same speaker and gap is reasonably small (e.g., < 750ms)
            if (nextSegment.userId === currentSegment.userId && timeBetween < 750) {
                currentSegment.endTime = nextSegment.endTime; // Extend the current segment
            } else {
                // Finish the current segment and start a new one
                consolidated.push(currentSegment);
                currentSegment = { ...nextSegment };
            }
        }
        consolidated.push(currentSegment); // Add the last segment

        // Final processing: calculate durations and filter out very short segments
        const finalSegments = consolidated
            .map(seg => ({
                ...seg,
                duration: seg.endTime - seg.startTime,
                relativeStart: seg.startTime - recordingStartTime,
                relativeEnd: seg.endTime - recordingStartTime
            }))
            .filter(seg => seg.duration > 1000); // Keep segments longer than 1 second

        return finalSegments;
    }

    getUserFiles(recordingData) {
        const userFiles = [];

        for (const [userId, streamData] of recordingData.userStreams) {
            const participant = recordingData.participants.get(userId);
            if (participant && fs.existsSync(streamData.filepath)) {
                const stats = fs.statSync(streamData.filepath);
                if (stats.size > 0) {
                    userFiles.push({
                        userId,
                        username: participant.username,
                        displayName: participant.displayName,
                        filepath: streamData.filepath,
                        filename: streamData.filename,
                        fileSize: stats.size
                    });
                }
            }
        }

        return userFiles;
    }

    isRecordingActive(guildId) {
        return this.recordings.has(guildId);
    }

    getAllActiveRecordings() {
        return Array.from(this.recordings.keys());
    }

    getRecordingStatus(guildId) {
        const recordingData = this.recordings.get(guildId);
        if (!recordingData) {
            return null;
        }

        return {
            guildId,
            startTime: recordingData.startTime,
            duration: Date.now() - recordingData.startTime,
            participants: Array.from(recordingData.participants.values()),
            speakingEvents: recordingData.speakingEvents.length
        };
    }
}

module.exports = new VoiceRecorder();
