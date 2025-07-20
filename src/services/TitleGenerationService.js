const fs = require('fs');
const path = require('path');
const axios = require('axios');
const config = require('../config');
const logger = require('../utils/logger');
const { ERROR_MESSAGES: _ERROR_MESSAGES } = require('../constants');

class TitleGenerationService {
    constructor() {
        this.groqApiKey = config.groq.apiKey;
        this.groqBaseUrl = 'https://api.groq.com/openai/v1';

        if (!this.groqApiKey) {
            logger.warn('GROQ_API_KEY not found in environment variables');
        }
    }

    /**
     * Generate a human-friendly title from transcript content
     * @param {string} transcriptContent - The full transcript content
     * @returns {Promise<{title: string, slug: string, metadata: object}>}
     */
    async generateTitle(transcriptContent) {
        if (!this.groqApiKey) {
            throw new Error('GROQ API key is required for title generation');
        }

        if (!transcriptContent || typeof transcriptContent !== 'string') {
            throw new Error('Invalid transcript content provided');
        }

        try {
            // Extract conversation text from transcript
            const conversationText = this.extractConversationText(transcriptContent);

            if (!conversationText || conversationText.trim().length === 0) {
                throw new Error('No conversation content found in transcript');
            }

            // Generate title using LLM
            const title = await this.generateTitleFromText(conversationText);

            // Create slug from title
            const slug = this.slugify(title);

            return {
                title: title.trim(),
                slug,
                metadata: {
                    generatedAt: new Date().toISOString(),
                    sourceLength: conversationText.length,
                    model: 'llama-3.1-8b-instant'
                }
            };

        } catch (error) {
            logger.error('Failed to generate title:', {
                error: error.message,
                stack: error.stack
            });
            throw error;
        }
    }

    /**
     * Extract conversation text from transcript markdown
     * @param {string} transcriptContent - Full transcript content
     * @returns {string} - Clean conversation text
     */
    extractConversationText(transcriptContent) {
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

    /**
     * Generate title using LLM
     * @param {string} conversationText - Clean conversation text
     * @returns {Promise<string>} - Generated title
     */
    async generateTitleFromText(conversationText) {
        // Truncate conversation if too long (keep first 2000 chars for context)
        const truncatedText = conversationText.length > 2000
            ? conversationText.substring(0, 2000) + '...'
            : conversationText;

        const systemPrompt = `You are a helpful assistant that creates concise, descriptive titles for voice conversation transcripts. 

Guidelines:
- Create a title that captures the main topic or purpose of the conversation
- Keep it between 3-8 words
- Make it human-friendly and descriptive
- Avoid generic words like "conversation", "discussion", "meeting" unless they add specific context
- Focus on the actual subject matter discussed
- Use title case (capitalize important words)
- Do not include quotes or special characters that would be problematic in filenames`;

        const userPrompt = `Please create a short, descriptive title for this voice conversation transcript:

${truncatedText}

Return only the title, nothing else.`;

        try {
            const response = await axios.post(`${this.groqBaseUrl}/chat/completions`, {
                model: 'llama-3.1-8b-instant',
                messages: [
                    {
                        role: 'system',
                        content: systemPrompt
                    },
                    {
                        role: 'user',
                        content: userPrompt
                    }
                ],
                temperature: 0.7,
                max_tokens: 50,
                top_p: 0.9,
                stream: false
            }, {
                headers: {
                    'Authorization': `Bearer ${this.groqApiKey}`,
                    'Content-Type': 'application/json'
                },
                timeout: 15000
            });

            const title = response.data.choices[0]?.message?.content;

            if (!title) {
                throw new Error('Empty response from title generation API');
            }

            // Clean up the title
            return this.cleanTitle(title.trim());

        } catch (error) {
            if (error.response) {
                logger.error(`Groq API error: ${error.response.status} - ${error.response.data?.error?.message || 'Unknown error'}`);
                throw new Error(`Title generation API error: ${error.response.status}`);
            } else if (error.code === 'ECONNABORTED') {
                throw new Error('Title generation API timeout');
            } else {
                throw new Error(`Title generation network error: ${error.message}`);
            }
        }
    }

    /**
     * Clean and validate generated title
     * @param {string} title - Raw title from LLM
     * @returns {string} - Cleaned title
     */
    cleanTitle(title) {
        // Remove quotes and problematic characters
        let cleaned = title.replace(/["""'']/g, '').trim();

        // Remove any remaining problematic filename characters
        cleaned = cleaned.replace(/[<>:"/\\|?*]/g, '');

        // Limit length
        if (cleaned.length > 60) {
            cleaned = cleaned.substring(0, 57) + '...';
        }

        // Fallback if title is empty or too short
        if (cleaned.length < 3) {
            cleaned = 'Voice Recording';
        }

        return cleaned;
    }

    /**
     * Convert title to URL-friendly slug
     * @param {string} title - Human-readable title
     * @returns {string} - URL-friendly slug
     */
    slugify(title) {
        return title
            .toLowerCase()
            .trim()
            .replace(/[^\w\s-]/g, '') // Remove special characters
            .replace(/[\s_-]+/g, '-') // Replace spaces and underscores with hyphens
            .replace(/^-+|-+$/g, ''); // Remove leading/trailing hyphens
    }

    /**
     * Save title metadata to file
     * @param {object} titleData - Title generation result
     * @param {string} transcriptId - Transcript identifier
     * @returns {Promise<object>} - Saved file info
     */
    async saveTitle(titleData, transcriptId) {
        const titleFileName = `title_${transcriptId}.json`;
        const titlePath = path.join(config.paths.recordings, titleFileName);

        const titleMetadata = {
            transcriptId,
            title: titleData.title,
            slug: titleData.slug,
            generatedAt: titleData.metadata.generatedAt,
            model: titleData.metadata.model,
            sourceLength: titleData.metadata.sourceLength
        };

        try {
            fs.writeFileSync(titlePath, JSON.stringify(titleMetadata, null, 2), 'utf8');
            logger.info(`Title metadata saved to ${titlePath}`);

            return {
                path: titlePath,
                fileName: titleFileName,
                metadata: titleMetadata
            };
        } catch (error) {
            logger.error(`Failed to save title metadata to ${titlePath}:`, error);
            throw new Error(`Failed to save title metadata: ${error.message}`);
        }
    }

    /**
     * Get title for a transcript
     * @param {string} transcriptId - Transcript identifier
     * @returns {Promise<object|null>} - Title metadata or null if not found
     */
    getTitle(transcriptId) {
        const titlePath = path.join(config.paths.recordings, `title_${transcriptId}.json`);

        if (!fs.existsSync(titlePath)) {
            return null;
        }

        try {
            const titleContent = fs.readFileSync(titlePath, 'utf8');
            return JSON.parse(titleContent);
        } catch (error) {
            logger.error(`Failed to read title metadata from ${titlePath}:`, error);
            return null;
        }
    }

    /**
     * Check if title exists for transcript
     * @param {string} transcriptId - Transcript identifier
     * @returns {boolean} - Whether title exists
     */
    titleExists(transcriptId) {
        const titlePath = path.join(config.paths.recordings, `title_${transcriptId}.json`);
        return fs.existsSync(titlePath);
    }

    /**
     * Generate fallback title from timestamp
     * @param {string} transcriptId - Transcript identifier
     * @returns {object} - Fallback title data
     */
    generateFallbackTitle(transcriptId) {
        // Extract timestamp from transcript ID if possible
        const timestampMatch = transcriptId.match(/(\d+)/);
        let title = 'Voice Recording';

        if (timestampMatch) {
            const timestamp = parseInt(timestampMatch[1]);
            const date = new Date(timestamp);
            if (!isNaN(date.getTime())) {
                title = `Recording ${date.toLocaleDateString()}`;
            }
        }

        return {
            title,
            slug: this.slugify(title),
            metadata: {
                generatedAt: new Date().toISOString(),
                sourceLength: 0,
                model: 'fallback'
            }
        };
    }
}

module.exports = new TitleGenerationService();
