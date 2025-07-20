const dotenv = require('dotenv');
const path = require('path');
const fs = require('fs');

class ConfigService {
    constructor() {
        this.config = null;
        this.initialized = false;
    }

    initialize() {
        if (this.initialized) {
            return this.config;
        }

        this.loadEnvironment();
        this.config = this.buildConfig();
        this.validateConfig();
        this.initialized = true;

        return this.config;
    }

    loadEnvironment() {
        // Only load .env file if not in production (Docker provides env vars directly)
        if (process.env.NODE_ENV !== 'production') {
            const envPath = path.join(process.cwd(), '.env');
            if (fs.existsSync(envPath)) {
                console.log('Loading .env file for development');
                dotenv.config();
            } else {
                console.warn('No .env file found for development mode');
            }
        } else {
            console.log('Production mode: using environment variables from docker-compose');
        }
    }

    buildConfig() {
        return {
            discord: {
                token: process.env.DISCORD_BOT_TOKEN,
                guildId: process.env.GUILD_ID
            },
            groq: {
                apiKey: process.env.GROQ_API_KEY
            },
            express: {
                port: this.parsePort(process.env.WEB_PORT || process.env.EXPRESS_PORT),
                host: process.env.WEB_HOST || '0.0.0.0',
                baseUrl: process.env.BASE_URL || this.generateBaseUrl()
            },
            security: {
                temporaryUrlExpiry: this.parseDuration(process.env.TEMP_URL_EXPIRY) || (24 * 60 * 60 * 1000) // 24 hours
            },
            audio: {
                quality: process.env.AUDIO_QUALITY || '192k',
                ffmpegPath: process.env.FFMPEG_PATH,
                sampleRate: 48000,
                channels: 2
            },
            paths: {
                recordings: path.resolve(process.env.RECORDINGS_PATH || './recordings'),
                temp: path.resolve(process.env.TEMP_PATH || './temp')
            },
            environment: process.env.NODE_ENV || 'development',
            logLevel: process.env.LOG_LEVEL || 'info'
        };
    }

    validateConfig() {
        const errors = [];

        // Required fields validation
        const requiredFields = [
            { path: 'discord.token', name: 'DISCORD_BOT_TOKEN', description: 'Discord bot token' },
            { path: 'groq.apiKey', name: 'GROQ_API_KEY', description: 'Groq API key for transcription' }
        ];

        for (const field of requiredFields) {
            if (!this.getNestedValue(this.config, field.path)) {
                errors.push({
                    field: field.name,
                    description: field.description,
                    fix: `Set ${field.name} environment variable`
                });
            }
        }

        // Type validation
        if (typeof this.config.express.port !== 'number' || this.config.express.port < 1 || this.config.express.port > 65535) {
            errors.push({
                field: 'WEB_PORT',
                description: 'Express server port',
                fix: 'Set WEB_PORT to a valid port number (1-65535)'
            });
        }

        // Audio quality validation
        const validQualities = ['64k', '128k', '192k', '256k', '320k'];
        if (!validQualities.includes(this.config.audio.quality)) {
            console.warn(`Invalid audio quality '${this.config.audio.quality}', using default '192k'`);
            this.config.audio.quality = '192k';
        }

        // Log level validation
        const validLogLevels = ['error', 'warn', 'info', 'debug'];
        if (!validLogLevels.includes(this.config.logLevel)) {
            console.warn(`Invalid log level '${this.config.logLevel}', using default 'info'`);
            this.config.logLevel = 'info';
        }

        // Directory validation
        this.ensureDirectoriesExist();

        if (errors.length > 0) {
            this.printConfigurationErrors(errors);
            throw new Error(`Configuration validation failed: ${errors.length} error(s) found`);
        }

        this.printConfigurationSummary();
    }

    ensureDirectoriesExist() {
        try {
            if (!fs.existsSync(this.config.paths.recordings)) {
                fs.mkdirSync(this.config.paths.recordings, { recursive: true });
                console.log(`Created recordings directory: ${this.config.paths.recordings}`);
            }

            if (!fs.existsSync(this.config.paths.temp)) {
                fs.mkdirSync(this.config.paths.temp, { recursive: true });
                console.log(`Created temp directory: ${this.config.paths.temp}`);
            }
        } catch (error) {
            throw new Error(`Failed to create required directories: ${error.message}`);
        }
    }

    parsePort(portStr) {
        if (!portStr) {
            return 3000;
        }
        const port = parseInt(portStr, 10);
        return isNaN(port) ? 3000 : port;
    }

    parseDuration(durationStr) {
        if (!durationStr) {
            return null;
        }

        // Parse formats like "24h", "30m", "1d"
        const match = durationStr.match(/^(\d+)([hmd])$/);
        if (!match) {
            return null;
        }

        const value = parseInt(match[1], 10);
        const unit = match[2];

        switch (unit) {
            case 'h': return value * 60 * 60 * 1000;
            case 'm': return value * 60 * 1000;
            case 'd': return value * 24 * 60 * 60 * 1000;
            default: return null;
        }
    }

    generateBaseUrl() {
        const port = this.parsePort(process.env.WEB_PORT || process.env.EXPRESS_PORT);
        const host = process.env.WEB_HOST || 'localhost';
        return `http://${host}:${port}`;
    }

    getNestedValue(obj, path) {
        return path.split('.').reduce((current, key) => current?.[key], obj);
    }

    printConfigurationErrors(errors) {
        console.error('\n' + '='.repeat(80));
        console.error('❌ CONFIGURATION ERRORS');
        console.error('='.repeat(80));
        console.error('SoundScribe failed to start due to configuration issues:\n');

        errors.forEach((error, index) => {
            console.error(`${index + 1}. ${error.description}`);
            console.error(`   Missing: ${error.field}`);
            console.error(`   Fix: ${error.fix}\n`);
        });

        console.error('Please fix these configuration issues and restart the application.');
        console.error('='.repeat(80) + '\n');
    }

    printConfigurationSummary() {
        console.log('\n' + '='.repeat(60));
        console.log('✅ CONFIGURATION VALIDATED');
        console.log('='.repeat(60));
        console.log(`Environment: ${this.config.environment}`);
        console.log(`Express: ${this.config.express.host}:${this.config.express.port}`);
        console.log(`Base URL: ${this.config.express.baseUrl}`);
        console.log(`Audio Quality: ${this.config.audio.quality}`);
        console.log(`Log Level: ${this.config.logLevel}`);
        console.log(`Recordings: ${this.config.paths.recordings}`);
        console.log(`Temp: ${this.config.paths.temp}`);
        console.log('='.repeat(60) + '\n');
    }

    get() {
        if (!this.initialized) {
            throw new Error('ConfigService not initialized. Call initialize() first.');
        }
        return this.config;
    }

    // Convenience getters for commonly used config sections
    getDiscord() {
        return this.get().discord;
    }

    getGroq() {
        return this.get().groq;
    }

    getExpress() {
        return this.get().express;
    }

    getAudio() {
        return this.get().audio;
    }

    getPaths() {
        return this.get().paths;
    }

    getSecurity() {
        return this.get().security;
    }

    isProduction() {
        return this.get().environment === 'production';
    }

    isDevelopment() {
        return this.get().environment === 'development';
    }
}

module.exports = new ConfigService();
