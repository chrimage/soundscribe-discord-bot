const fs = require('fs');
const path = require('path');
const axios = require('axios');
const config = require('../config');
const logger = require('../utils/logger');
const { SUMMARIZATION, ERROR_MESSAGES } = require('../constants');

class SummarizationService {
    constructor() {
        this.groqApiKey = config.groq.apiKey;
        this.groqBaseUrl = 'https://api.groq.com/openai/v1';

        if (!this.groqApiKey) {
            logger.warn('GROQ_API_KEY not found in environment variables');
        }
    }

    async summarizeTranscript(transcriptPath, type = 'detailed') {
        if (!this.groqApiKey) {
            throw new Error(ERROR_MESSAGES.SUMMARIZATION.API_KEY_MISSING);
        }

        if (!fs.existsSync(transcriptPath)) {
            throw new Error(`Transcript file not found: ${transcriptPath}`);
        }

        try {
            logger.info(`Reading transcript file: ${transcriptPath}`);
            const transcriptContent = fs.readFileSync(transcriptPath, 'utf8');
            logger.debug(`Transcript content length: ${transcriptContent ? transcriptContent.length : 'undefined'}`);

            // Validate transcript content
            if (!transcriptContent || typeof transcriptContent !== 'string') {
                logger.error(`Invalid transcript content - type: ${typeof transcriptContent}, length: ${transcriptContent ? transcriptContent.length : 'N/A'}`);
                throw new Error(`Transcript file is empty or unreadable: ${transcriptPath}`);
            }

            const conversationText = this.extractConversationText(transcriptContent);

            if (!conversationText || conversationText.trim().length === 0) {
                throw new Error(ERROR_MESSAGES.SUMMARIZATION.NO_CONTENT);
            }

            const summary = await this.generateSummary(conversationText, type);

            return {
                summary: summary.text,
                type,
                metadata: {
                    originalLength: conversationText.length,
                    summaryLength: summary.text.length,
                    compressionRatio: Math.round((summary.text.length / conversationText.length) * 100),
                    generatedAt: new Date().toISOString()
                }
            };

        } catch (error) {
            logger.error(`Failed to summarize transcript ${transcriptPath}:`, error);
            throw error;
        }
    }

    extractConversationText(transcriptContent) {
        // Additional safety check
        if (!transcriptContent || typeof transcriptContent !== 'string') {
            logger.error('extractConversationText received invalid input:', typeof transcriptContent);
            throw new Error('Invalid transcript content provided to extractConversationText');
        }

        const lines = transcriptContent.split('\n');
        const conversationLines = [];
        let inConversation = false;

        for (const line of lines) {
            // Start collecting after the separator line
            if (line.trim() === '---') {
                inConversation = true;
                continue;
            }

            if (inConversation && line.trim()) {
                // Skip speaker lines that start with **[timestamp]
                if (line.startsWith('**[')) {
                    const speakerMatch = line.match(/\*\*\[.*?\]\s*(.+?)(?:\s*\([\d.]+%\))?\*\*:/);
                    if (speakerMatch) {
                        conversationLines.push(`${speakerMatch[1]}:`);
                    }
                } else if (!line.startsWith('**') && !line.startsWith('#')) {
                    // This is the actual speech content
                    conversationLines.push(line.trim());
                }
            }
        }

        return conversationLines.join('\n');
    }

    async generateSummary(conversationText, type) {
        const prompt = this.buildSummarizationPrompt(conversationText, type);

        try {
            const response = await axios.post(`${this.groqBaseUrl}/chat/completions`, {
                model: SUMMARIZATION.DEFAULT_MODEL,
                messages: [
                    {
                        role: 'system',
                        content: SUMMARIZATION.SYSTEM_PROMPTS[type]
                    },
                    {
                        role: 'user',
                        content: prompt
                    }
                ],
                temperature: SUMMARIZATION.TEMPERATURE,
                max_tokens: SUMMARIZATION.MAX_TOKENS[type],
                top_p: SUMMARIZATION.TOP_P,
                stream: false
            }, {
                headers: {
                    'Authorization': `Bearer ${this.groqApiKey}`,
                    'Content-Type': 'application/json'
                },
                timeout: SUMMARIZATION.API_TIMEOUT_MS
            });

            const summaryText = response.data.choices[0]?.message?.content;

            if (!summaryText) {
                throw new Error('Empty response from summarization API');
            }

            return {
                text: summaryText.trim(),
                model: SUMMARIZATION.DEFAULT_MODEL,
                tokensUsed: response.data.usage?.total_tokens || 0
            };

        } catch (error) {
            if (error.response) {
                logger.error(`Groq API error: ${error.response.status} - ${error.response.data?.error?.message || 'Unknown error'}`);
                throw new Error(`${ERROR_MESSAGES.SUMMARIZATION.API_ERROR}: ${error.response.status}`);
            } else if (error.code === 'ECONNABORTED') {
                throw new Error(ERROR_MESSAGES.SUMMARIZATION.API_TIMEOUT);
            } else {
                throw new Error(`${ERROR_MESSAGES.SUMMARIZATION.NETWORK_ERROR}: ${error.message}`);
            }
        }
    }

    buildSummarizationPrompt(conversationText, type) {
        const maxLength = type === 'brief' ? 150 : 800;

        return `Please summarize the following conversation transcript. The summary should be ${maxLength} words or less.

Conversation:
${conversationText}

Please provide a ${type} summary that captures the key points, main topics discussed, and any important decisions or outcomes.`;
    }

    async saveSummary(summary, transcriptId, type) {
        const summaryFileName = `${transcriptId}_summary_${type}.md`;
        const summaryPath = path.join(config.paths.recordings, summaryFileName);

        const summaryContent = this.formatSummary(summary, type);

        try {
            fs.writeFileSync(summaryPath, summaryContent, 'utf8');
            logger.info(`Summary saved to ${summaryPath}`);

            return {
                path: summaryPath,
                fileName: summaryFileName,
                url: `/api/summary/${transcriptId}/${type}`
            };
        } catch (error) {
            logger.error(`Failed to save summary to ${summaryPath}:`, error);
            throw new Error(`Failed to save summary: ${error.message}`);
        }
    }

    formatSummary(summary, type) {
        const lines = [];

        lines.push(`# ${type.charAt(0).toUpperCase() + type.slice(1)} Summary`);
        lines.push('');
        lines.push(`**Generated:** ${summary.metadata.generatedAt}`);
        lines.push(`**Type:** ${type}`);
        lines.push(`**Compression:** ${100 - summary.metadata.compressionRatio}% reduction`);
        lines.push('');
        lines.push('---');
        lines.push('');
        lines.push(summary.summary);
        lines.push('');
        lines.push('---');
        lines.push('');
        lines.push(`*Generated with ${SUMMARIZATION.DEFAULT_MODEL}*`);

        return lines.join('\n');
    }

    getSummaryPath(transcriptId, type) {
        const summaryFileName = `${transcriptId}_summary_${type}.md`;
        return path.join(config.paths.recordings, summaryFileName);
    }

    summaryExists(transcriptId, type) {
        const summaryPath = this.getSummaryPath(transcriptId, type);
        return fs.existsSync(summaryPath);
    }

    getSummary(transcriptId, type) {
        const summaryPath = this.getSummaryPath(transcriptId, type);

        if (!fs.existsSync(summaryPath)) {
            throw new Error(`Summary not found: ${summaryPath}`);
        }

        try {
            const summaryContent = fs.readFileSync(summaryPath, 'utf8');
            return {
                content: summaryContent,
                path: summaryPath,
                type,
                transcriptId
            };
        } catch (error) {
            logger.error(`Failed to read summary from ${summaryPath}:`, error);
            throw new Error(`Failed to read summary: ${error.message}`);
        }
    }

    validateSummaryType(type) {
        const validTypes = ['brief', 'detailed', 'key_points'];
        return validTypes.includes(type);
    }
}

module.exports = new SummarizationService();
