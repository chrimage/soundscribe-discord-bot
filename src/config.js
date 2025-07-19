const dotenv = require('dotenv');

// Only load .env file if not in production (Docker provides env vars directly)
if (process.env.NODE_ENV !== 'production') {
    console.log('Loading .env file for development');
    dotenv.config();
} else {
    console.log('Production mode: using environment variables from docker-compose');
}

const requiredEnvVars = [
    'DISCORD_BOT_TOKEN',
    'GROQ_API_KEY'
];

function validateEnv() {
    console.log('Environment check - NODE_ENV:', process.env.NODE_ENV);
    console.log('DISCORD_BOT_TOKEN present:', !!process.env.DISCORD_BOT_TOKEN);
    console.log('GROQ_API_KEY present:', !!process.env.GROQ_API_KEY);
    
    const missing = requiredEnvVars.filter(varName => !process.env[varName]);

    if (missing.length > 0) {
        console.error('Missing required environment variables:', missing.join(', '));
        console.error('Please copy .env.example to .env and fill in the required values');
        throw new Error(`Missing environment variables: ${missing.join(', ')}`);
    }
}

const config = {
    discord: {
        token: process.env.DISCORD_BOT_TOKEN,
        guildId: process.env.GUILD_ID
    },
    groq: {
        apiKey: process.env.GROQ_API_KEY
    },
    express: {
        port: parseInt(process.env.WEB_PORT || process.env.EXPRESS_PORT) || 3000,
        baseUrl: process.env.BASE_URL || `http://localhost:${process.env.WEB_PORT || process.env.EXPRESS_PORT || 3000}`
    },
    security: {
        temporaryUrlExpiry: 24 * 60 * 60 * 1000 // 24 hours in milliseconds
    },
    audio: {
        quality: process.env.AUDIO_QUALITY || '192k',
        ffmpegPath: process.env.FFMPEG_PATH,
        sampleRate: 48000,
        channels: 2
    },
    paths: {
        recordings: './recordings',
        temp: './temp'
    },
    environment: process.env.NODE_ENV || 'development',
    logLevel: process.env.LOG_LEVEL || 'info'
};

validateEnv();

module.exports = config;
