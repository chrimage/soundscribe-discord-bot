// Transcription Service Constants
const TRANSCRIPTION = {
    // File size limits
    MAX_FILE_SIZE_BYTES: 100 * 1024 * 1024, // 100MB (Groq API limit)
    MIN_FILE_SIZE_BYTES: 10000, // 10KB minimum for meaningful audio

    // Audio quality thresholds
    MIN_AUDIO_ENERGY: 0.01, // RMS energy threshold for silence detection
    MIN_PEAK_AMPLITUDE: 0.05, // Peak amplitude threshold

    // API configuration
    API_TIMEOUT_MS: 30000, // 30 seconds
    DEFAULT_MODEL: 'whisper-large-v3-turbo',
    DEFAULT_LANGUAGE: 'en',
    RESPONSE_FORMAT: 'verbose_json',

    // Confidence score thresholds
    LOW_CONFIDENCE_THRESHOLD: 20, // Below 20% is considered low confidence
    MIN_CONFIDENCE_FOR_DISPLAY: 5 // Below 5% probably shouldn't be shown
};

// Summarization Service Constants
const SUMMARIZATION = {
    // API configuration
    API_TIMEOUT_MS: 60000, // 60 seconds for summarization
    DEFAULT_MODEL: 'meta-llama/llama-4-scout-17b-16e-instruct',
    TEMPERATURE: 0.7,
    TOP_P: 1.0,

    // Token limits for different summary types
    MAX_TOKENS: {
        brief: 300,      // ~150-200 words
        detailed: 1000,  // ~500-800 words
        key_points: 500  // ~250-400 words
    },

    // System prompts for different summary types
    SYSTEM_PROMPTS: {
        brief: 'You are a helpful assistant that creates concise summaries of conversations. Focus on the main topics and key takeaways in 2-3 sentences.',
        detailed: 'You are a helpful assistant that creates comprehensive summaries of conversations. Include main topics, key points, decisions made, and important context. Structure your response with clear sections if appropriate.',
        key_points: 'You are a helpful assistant that extracts key points from conversations. Present the main topics and important information as a bulleted list with brief explanations.'
    },

    // Discord message limits
    DISCORD_MAX_MESSAGE_LENGTH: 2000,
    BRIEF_SUMMARY_MAX_LENGTH: 1800 // Leave room for formatting
};

// Voice Recording Constants
const RECORDING = {
    // Speech segmentation timing
    SEGMENT_END_DELAY_MS: 3000, // 3 seconds delay before ending segment
    MIN_SEGMENT_DURATION_MS: 4000, // 4 seconds minimum for transcription

    // Cleanup and processing
    CLEANUP_TIMEOUT_MS: 5000, // 5 seconds for cleanup operations
    FILE_WRITE_COMPLETION_WAIT_MS: 2000, // 2 seconds wait for file writes

    // Audio stream configuration
    OPUS_SAMPLE_RATE: 48000,
    OPUS_CHANNELS: 2,
    OPUS_FRAME_SIZE: 960,

    // Logging throttling
    MAX_AUDIO_DATA_LOGS_PER_SECOND: 5 // Limit audio data logging
};

// Command Handler Constants
const COMMANDS = {
    // File processing
    MIN_USER_FILE_SIZE_BYTES: 1000, // 1KB minimum for user files
    TRANSCRIPT_FILE_PREFIX: 'transcript_',
    SEGMENTS_FILE_SUFFIX: '_segments.json',

    // User feedback
    PROCESSING_UPDATE_INTERVAL_MS: 5000, // Update user every 5 seconds during processing
    MAX_COMMAND_EXECUTION_TIME_MS: 300000, // 5 minutes max command execution

    // Rate limiting (future use)
    MAX_TRANSCRIBE_REQUESTS_PER_HOUR: 10,
    MAX_RECORDING_DURATION_MS: 3600000 // 1 hour max recording
};

// Error Messages
const ERROR_MESSAGES = {
    TRANSCRIPTION: {
        API_KEY_MISSING: 'Groq API key not configured',
        FILE_TOO_LARGE: 'Audio file too large for transcription (max 100MB)',
        FILE_TOO_SMALL: 'Audio file too small (likely silence)',
        LOW_AUDIO_ENERGY: 'Audio energy too low (likely silence)',
        API_TIMEOUT: 'Transcription request timed out',
        API_ERROR: 'Transcription service error',
        NETWORK_ERROR: 'Network error during transcription',
        CONVERSION_FAILED: 'Audio format conversion failed'
    },
    SUMMARIZATION: {
        API_KEY_MISSING: 'Groq API key not configured',
        NO_CONTENT: 'No conversation content found to summarize',
        API_TIMEOUT: 'Summarization request timed out',
        API_ERROR: 'Summarization service error',
        NETWORK_ERROR: 'Network error during summarization',
        INVALID_TYPE: 'Invalid summary type specified',
        SUMMARY_NOT_FOUND: 'Summary not found'
    },
    RECORDING: {
        ALREADY_RECORDING: 'A recording is already in progress',
        NOT_IN_VOICE: 'You must be in a voice channel to record',
        NO_ACTIVE_RECORDING: 'No active recording found',
        STREAM_SETUP_FAILED: 'Failed to set up audio stream',
        NO_AUDIO_CAPTURED: 'No audio was captured during recording',
        CLEANUP_FAILED: 'Failed to clean up recording files'
    },
    COMMANDS: {
        NO_RECORDINGS: 'No recordings found',
        NO_SEGMENTS: 'No speech segments found for transcription',
        SEGMENTS_MISSING: 'Speech segment files not found',
        INVALID_METADATA: 'Invalid or corrupted segment metadata',
        PROCESSING_FAILED: 'Failed to process recording'
    }
};

// Success Messages
const SUCCESS_MESSAGES = {
    RECORDING_STARTED: '🎙️ Started recording! Use /stop to finish.',
    RECORDING_STOPPED: '✅ Recording completed!',
    TRANSCRIPTION_STARTED: '🤖 Starting transcription...',
    TRANSCRIPTION_COMPLETED: '✅ Transcription completed!',
    PROCESSING_AUDIO: '⏳ Processing audio...',
    GENERATING_TRANSCRIPT: '⏳ Generating transcript...'
};

module.exports = {
    TRANSCRIPTION,
    SUMMARIZATION,
    RECORDING,
    COMMANDS,
    ERROR_MESSAGES,
    SUCCESS_MESSAGES
};
