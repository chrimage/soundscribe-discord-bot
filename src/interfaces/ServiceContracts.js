/**
 * Service Contracts - Stable interfaces for core services
 * These interfaces define the public API contracts that external code can rely on.
 * Changes to these interfaces should maintain backward compatibility.
 */

class AudioProcessorContract {
    /**
     * Standard audio processing pipeline: PCM → WAV → MP3
     * @param {Object} recordingResult - Recording result with userFiles
     * @param {Array} recordingResult.userFiles - Array of user audio files
     * @returns {Promise<Object>} Processing result with outputFile, fileSize, participants
     */
    async createMixedRecording(recordingResult) {
        throw new Error('Method must be implemented by AudioProcessor');
    }

    /**
     * Convert PCM to WAV (intermediate step)
     * @param {string} pcmFilePath - Path to PCM file
     * @param {string} outputPath - Path for WAV output
     * @returns {Promise<void>}
     */
    async convertPcmToWav(pcmFilePath, outputPath) {
        throw new Error('Method must be implemented by AudioProcessor');
    }

    /**
     * Convert WAV to MP3 (final step)
     * @param {string} wavFilePath - Path to WAV file
     * @param {string} outputPath - Path for MP3 output
     * @returns {Promise<void>}
     */
    async convertWavToMp3(wavFilePath, outputPath) {
        throw new Error('Method must be implemented by AudioProcessor');
    }

    /**
     * Mix multiple PCM files into single WAV
     * @param {Array} userFiles - Array of user audio files
     * @param {string} outputPath - Path for WAV output
     * @returns {Promise<void>}
     */
    async mixPcmToWav(userFiles, outputPath) {
        throw new Error('Method must be implemented by AudioProcessor');
    }

    /**
     * Validate FFmpeg installation
     * @returns {Promise<boolean>}
     */
    async validateFFmpeg() {
        throw new Error('Method must be implemented by AudioProcessor');
    }

    /**
     * Clean up temporary files
     * @param {string} tempDir - Temporary directory to clean
     * @returns {void}
     */
    cleanupTempFiles(tempDir) {
        throw new Error('Method must be implemented by AudioProcessor');
    }
}

class TranscriptionServiceContract {
    /**
     * Transcribe speech segments
     * @param {Array} speechSegments - Array of speech segments
     * @param {Array} userFiles - Array of user audio files
     * @returns {Promise<Array>} Array of transcription results
     */
    async transcribeSpeechSegments(speechSegments, userFiles) {
        throw new Error('Method must be implemented by TranscriptionService');
    }

    /**
     * Legacy method for backward compatibility
     * @param {Array} audioSources - Array of audio sources to transcribe
     * @returns {Promise<Array>} Array of transcription results
     */
    async transcribeSegments(audioSources) {
        throw new Error('Method must be implemented by TranscriptionService');
    }

    /**
     * Format transcript from transcription results
     * @param {Array} transcriptionResults - Raw transcription results
     * @returns {Object} Formatted transcript with text and metadata
     */
    formatTranscript(transcriptionResults) {
        throw new Error('Method must be implemented by TranscriptionService');
    }

    /**
     * Extract audio segment from PCM file
     * @param {string} pcmFilePath - Path to PCM file
     * @param {number} startMs - Start time in milliseconds
     * @param {number} durationMs - Duration in milliseconds
     * @returns {Promise<string>} Path to extracted segment
     */
    async extractAudioSegment(pcmFilePath, startMs, durationMs) {
        throw new Error('Method must be implemented by TranscriptionService');
    }
}

class VoiceRecorderContract {
    /**
     * Start recording in a voice channel
     * @param {Object} interaction - Discord interaction object
     * @returns {Promise<boolean>} Success status
     */
    async startRecording(interaction) {
        throw new Error('Method must be implemented by VoiceRecorder');
    }

    /**
     * Join a voice channel
     * @param {Object} channel - Discord voice channel
     * @param {number} retryCount - Retry attempt count
     * @returns {Promise<boolean>} Success status
     */
    async joinChannel(channel, retryCount = 0) {
        throw new Error('Method must be implemented by VoiceRecorder');
    }

    /**
     * Stop recording and return results
     * @param {string} guildId - Discord guild ID
     * @returns {Promise<Object>} Recording results
     */
    async stopRecording(guildId) {
        throw new Error('Method must be implemented by VoiceRecorder');
    }

    /**
     * Check if recording is active
     * @param {string} guildId - Discord guild ID
     * @returns {boolean} Recording status
     */
    isRecordingActive(guildId) {
        throw new Error('Method must be implemented by VoiceRecorder');
    }

    /**
     * Set Discord client reference
     * @param {Object} client - Discord.js client
     */
    setClient(client) {
        throw new Error('Method must be implemented by VoiceRecorder');
    }
}

class BackgroundJobManagerContract {
    /**
     * Queue a transcription job
     * @param {Object} jobData - Job data including recording info
     * @returns {number} Job ID
     */
    queueTranscription(jobData) {
        throw new Error('Method must be implemented by BackgroundJobManager');
    }

    /**
     * Process a transcription job
     * @param {number} jobId - Job ID
     * @param {Object} jobData - Job data
     * @returns {Promise<void>}
     */
    async processTranscription(jobId, jobData) {
        throw new Error('Method must be implemented by BackgroundJobManager');
    }

    /**
     * Get job status
     * @param {number} jobId - Job ID
     * @returns {Object|null} Job status or null if not found
     */
    getJobStatus(jobId) {
        throw new Error('Method must be implemented by BackgroundJobManager');
    }
}

/**
 * Interface validation helper
 * Validates that a service implements the required contract
 */
class ContractValidator {
    /**
     * Validate service against contract
     * @param {Object} service - Service instance
     * @param {Function} contract - Contract class
     * @param {string} serviceName - Service name for error messages
     * @throws {Error} If service doesn't implement contract
     */
    static validate(service, contract, serviceName) {
        const contractMethods = Object.getOwnPropertyNames(contract.prototype)
            .filter(name => name !== 'constructor' && typeof contract.prototype[name] === 'function');

        const missing = [];
        for (const method of contractMethods) {
            if (typeof service[method] !== 'function') {
                missing.push(method);
            }
        }

        if (missing.length > 0) {
            throw new Error(`${serviceName} missing contract methods: ${missing.join(', ')}`);
        }
    }

    /**
     * Validate all core services
     * @param {Object} services - Object containing service instances
     */
    static validateCoreServices(services) {
        const validations = [
            { service: services.audioProcessor, contract: AudioProcessorContract, name: 'AudioProcessor' },
            { service: services.transcriptionService, contract: TranscriptionServiceContract, name: 'TranscriptionService' },
            { service: services.voiceRecorder, contract: VoiceRecorderContract, name: 'VoiceRecorder' },
            { service: services.backgroundJobManager, contract: BackgroundJobManagerContract, name: 'BackgroundJobManager' }
        ];

        for (const { service, contract, name } of validations) {
            if (service) {
                this.validate(service, contract, name);
            }
        }
    }
}

module.exports = {
    AudioProcessorContract,
    TranscriptionServiceContract,
    VoiceRecorderContract,
    BackgroundJobManagerContract,
    ContractValidator
};