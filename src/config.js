// Centralized configuration service with validation
const configService = require('./utils/ConfigService');

// Initialize and validate configuration
const config = configService.initialize();

module.exports = config;
