const logger = require('./logger');
const { TranscriptionError, RecordingError, ValidationError, getUserFriendlyMessage } = require('./errors');

class ErrorHandler {
    /**
     * Wraps command execution with comprehensive error handling
     * @param {Function} commandExecutor - The command function to execute
     * @param {Object} context - Command context (interaction, guildId, userId, etc.)
     * @returns {Function} Wrapped command executor
     */
    static wrapCommand(commandExecutor, commandName) {
        return async (interaction, dependencies = {}) => {
            const context = {
                commandName,
                guildId: interaction.guild?.id,
                userId: interaction.user?.id,
                username: interaction.user?.username,
                channelId: interaction.channel?.id
            };

            try {
                // Log command execution start
                logger.info(`Command execution started: ${commandName}`, {
                    ...context,
                    timestamp: new Date().toISOString()
                });

                // Execute the command
                const result = await commandExecutor(interaction, dependencies);

                // Log successful completion
                logger.info(`Command execution completed: ${commandName}`, {
                    ...context,
                    success: true,
                    timestamp: new Date().toISOString()
                });

                return result;

            } catch (error) {
                return await this.handleCommandError(error, interaction, context);
            }
        };
    }

    /**
     * Handles command execution errors with proper logging and user feedback
     */
    static async handleCommandError(error, interaction, context) {
        // Create detailed error context
        const errorContext = {
            ...context,
            error: {
                name: error.name,
                message: error.message,
                code: error.code,
                stack: error.stack
            },
            timestamp: new Date().toISOString()
        };

        // Log error with full context
        logger.error(`Command execution failed: ${context.commandName}`, errorContext);

        // Get user-friendly error message
        const userMessage = getUserFriendlyMessage(error);

        // Prepare response object
        const response = {
            content: userMessage,
            ephemeral: true
        };

        try {
            // Try to respond to the interaction
            if (interaction.deferred || interaction.replied) {
                await interaction.editReply(response);
            } else {
                await interaction.reply(response);
            }
        } catch (interactionError) {
            // If interaction fails, log it but don't throw
            logger.error('Failed to respond to interaction (may have timed out)', {
                ...errorContext,
                interactionError: {
                    name: interactionError.name,
                    message: interactionError.message
                }
            });
        }

        // For development, also log the full stack trace
        if (process.env.NODE_ENV === 'development') {
            console.error(`[${context.commandName}] Error:`, error);
        }
    }

    /**
     * Wraps service calls with error conversion to typed errors
     */
    static wrapService(serviceCall, serviceName, operation) {
        return async (...args) => {
            try {
                return await serviceCall(...args);
            } catch (error) {
                // Convert generic errors to typed errors based on service
                const typedError = this.convertToTypedError(error, serviceName, operation);
                
                // Log service error with context
                logger.error(`Service error: ${serviceName}.${operation}`, {
                    serviceName,
                    operation,
                    originalError: error.message,
                    convertedError: typedError.code,
                    timestamp: new Date().toISOString()
                });

                throw typedError;
            }
        };
    }

    /**
     * Converts generic errors to typed errors based on service and operation
     */
    static convertToTypedError(error, serviceName, operation) {
        // If it's already a typed error, return as-is
        if (error instanceof TranscriptionError || 
            error instanceof RecordingError || 
            error instanceof ValidationError) {
            return error;
        }

        // Convert based on service type
        switch (serviceName) {
            case 'TranscriptionService':
                return this.convertTranscriptionError(error, operation);
                
            case 'VoiceRecorder':
            case 'AudioProcessor':
                return this.convertRecordingError(error, operation);
                
            default:
                // Generic validation error for unknown services
                return new ValidationError(error.message, 'GENERIC_ERROR', {
                    service: serviceName,
                    operation: operation,
                    originalError: error.name
                });
        }
    }

    static convertTranscriptionError(error, operation) {
        const message = error.message.toLowerCase();

        if (message.includes('api key') || message.includes('unauthorized')) {
            return new TranscriptionError('API key missing or invalid', 'API_KEY_MISSING');
        }
        
        if (message.includes('file too large') || message.includes('size')) {
            return new TranscriptionError('Audio file too large for transcription', 'FILE_TOO_LARGE');
        }
        
        if (message.includes('timeout') || message.includes('timed out')) {
            return new TranscriptionError('Transcription request timed out', 'API_TIMEOUT');
        }
        
        if (message.includes('network') || message.includes('connection')) {
            return new TranscriptionError('Network error during transcription', 'NETWORK_ERROR');
        }
        
        if (message.includes('conversion') || message.includes('ffmpeg')) {
            return new TranscriptionError('Audio format conversion failed', 'CONVERSION_FAILED');
        }

        return new TranscriptionError(error.message, 'API_ERROR');
    }

    static convertRecordingError(error, operation) {
        const message = error.message.toLowerCase();

        if (message.includes('already recording') || message.includes('already connected')) {
            return new RecordingError('A recording is already in progress', 'ALREADY_RECORDING');
        }
        
        if (message.includes('voice channel') || message.includes('not in voice')) {
            return new RecordingError('User must be in a voice channel', 'NOT_IN_VOICE');
        }
        
        if (message.includes('no recording') || message.includes('not recording')) {
            return new RecordingError('No active recording found', 'NO_ACTIVE_RECORDING');
        }
        
        if (message.includes('no audio') || message.includes('empty')) {
            return new RecordingError('No audio was captured during recording', 'NO_AUDIO_CAPTURED');
        }
        
        if (message.includes('stream') || message.includes('connection')) {
            return new RecordingError('Failed to set up audio recording', 'STREAM_SETUP_FAILED');
        }

        return new RecordingError(error.message, 'RECORDING_ERROR');
    }

    /**
     * Creates a safe async wrapper that catches and logs unhandled promise rejections
     */
    static wrapAsync(asyncFunction, context = {}) {
        return async (...args) => {
            try {
                return await asyncFunction(...args);
            } catch (error) {
                logger.error('Unhandled async error', {
                    ...context,
                    error: {
                        name: error.name,
                        message: error.message,
                        stack: error.stack
                    },
                    timestamp: new Date().toISOString()
                });
                throw error;
            }
        };
    }
}

module.exports = ErrorHandler;