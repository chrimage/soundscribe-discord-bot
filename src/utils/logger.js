const config = require('../config');

const logLevels = {
    error: 0,
    warn: 1,
    info: 2,
    debug: 3
};

const currentLevel = logLevels[config.logLevel] || logLevels.info;

function formatMessage(level, message, ...args) {
    const timestamp = new Date().toISOString();
    const formattedArgs = args.length > 0 ? ' ' + args.map(arg =>
        typeof arg === 'object' ? JSON.stringify(arg) : String(arg)
    ).join(' ') : '';

    return `[${timestamp}] [${level.toUpperCase()}] ${message}${formattedArgs}`;
}

const logger = {
    error: (message, ...args) => {
        if (currentLevel >= logLevels.error) {
            console.error(formatMessage('error', message, ...args));
        }
    },

    warn: (message, ...args) => {
        if (currentLevel >= logLevels.warn) {
            console.warn(formatMessage('warn', message, ...args));
        }
    },

    info: (message, ...args) => {
        if (currentLevel >= logLevels.info) {
            console.log(formatMessage('info', message, ...args));
        }
    },

    debug: (message, ...args) => {
        if (currentLevel >= logLevels.debug) {
            console.log(formatMessage('debug', message, ...args));
        }
    }
};

module.exports = logger;
