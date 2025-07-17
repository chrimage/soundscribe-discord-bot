const { ERROR_MESSAGES } = require('../constants');

class TranscriptionError extends Error {
    constructor(message, code = 'TRANSCRIPTION_ERROR', details = null) {
        super(message);
        this.name = 'TranscriptionError';
        this.code = code;
        this.details = details;
    }
}

class RecordingError extends Error {
    constructor(message, code = 'RECORDING_ERROR', details = null) {
        super(message);
        this.name = 'RecordingError';
        this.code = code;
        this.details = details;
    }
}

class ValidationError extends Error {
    constructor(message, code = 'VALIDATION_ERROR', details = null) {
        super(message);
        this.name = 'ValidationError';
        this.code = code;
        this.details = details;
    }
}

// Helper function to create user-friendly error messages
function getUserFriendlyMessage(error) {
    if (error instanceof TranscriptionError) {
        switch (error.code) {
            case 'API_KEY_MISSING':
                return '❌ Transcription service not configured properly. Please contact an administrator.';
            case 'FILE_TOO_LARGE':
                return '❌ Audio file too large for transcription (maximum 100MB).';
            case 'FILE_TOO_SMALL':
                return '⚠️ Audio segment too small to transcribe (likely silence).';
            case 'LOW_AUDIO_ENERGY':
                return '⚠️ Audio quality too low for transcription (likely background noise).';
            case 'API_TIMEOUT':
                return '⏱️ Transcription request timed out. Please try again.';
            case 'API_ERROR':
                return '❌ Transcription service error. Please try again later.';
            case 'NETWORK_ERROR':
                return '🌐 Network error during transcription. Check your connection.';
            case 'CONVERSION_FAILED':
                return '🔄 Audio format conversion failed. The audio file may be corrupted.';
            default:
                return `❌ Transcription failed: ${error.message}`;
        }
    }
    
    if (error instanceof RecordingError) {
        switch (error.code) {
            case 'ALREADY_RECORDING':
                return '⚠️ A recording is already in progress in this server.';
            case 'NOT_IN_VOICE':
                return '🎤 You must be in a voice channel to start recording.';
            case 'NO_ACTIVE_RECORDING':
                return '❌ No active recording found in this server.';
            case 'STREAM_SETUP_FAILED':
                return '❌ Failed to set up audio recording. Please try again.';
            case 'NO_AUDIO_CAPTURED':
                return '🔇 No audio was captured during recording. Make sure people spoke and weren\'t muted.';
            case 'CLEANUP_FAILED':
                return '⚠️ Recording completed but cleanup failed. Files may remain on disk.';
            default:
                return `❌ Recording failed: ${error.message}`;
        }
    }
    
    if (error instanceof ValidationError) {
        return `❌ Invalid input: ${error.message}`;
    }
    
    // Generic error fallback
    return `❌ An unexpected error occurred: ${error.message}`;
}

module.exports = {
    TranscriptionError,
    RecordingError,
    ValidationError,
    getUserFriendlyMessage
};