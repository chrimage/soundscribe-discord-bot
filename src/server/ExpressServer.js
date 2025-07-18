const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const config = require('../config');
const logger = require('../utils/logger');
const fileManager = require('../utils/fileManager');
const summarizationService = require('../services/SummarizationService');

class ExpressServer {
    constructor() {
        this.app = express();
        this.temporaryUrls = new Map(); // Store temporary URLs
        this.setupMiddleware();
        this.setupRoutes();
        this.cleanupExpiredUrls();
    }

    setupMiddleware() {
        this.app.use(express.json());

        // Security headers
        this.app.use((req, res, next) => {
            res.setHeader('X-Content-Type-Options', 'nosniff');
            res.setHeader('X-Frame-Options', 'DENY');
            res.setHeader('X-XSS-Protection', '1; mode=block');
            next();
        });
    }

    setupRoutes() {
        // Health check endpoint
        this.app.get('/health', (req, res) => {
            res.json({
                status: 'ok',
                timestamp: new Date().toISOString(),
                uptime: process.uptime()
            });
        });

        // Test endpoint for Docker deployment verification
        this.app.get('/test', (req, res) => {
            res.json({
                message: '🎉 SoundScribe Docker deployment is working!',
                timestamp: new Date().toISOString(),
                version: '1.0.0',
                environment: process.env.NODE_ENV || 'development',
                availableEndpoints: [
                    'GET /health - Health check',
                    'GET /test - This test endpoint',
                    'GET /recordings - List recordings',
                    'GET /stats - Server statistics',
                    'GET / - React frontend application'
                ]
            });
        });

        // API endpoint to get transcript data
        this.app.get('/api/transcript/:id', (req, res) => {
            const transcriptId = req.params.id;

            // Validate transcript ID to prevent path traversal
            if (!transcriptId || !/^[a-zA-Z0-9_-]+$/.test(transcriptId)) {
                return res.status(400).json({ error: 'Invalid transcript ID' });
            }

            try {
                const transcriptPath = path.join(config.paths.recordings, `transcript_${transcriptId}.md`);

                if (!fs.existsSync(transcriptPath)) {
                    return res.status(404).json({ error: 'Transcript not found' });
                }

                const content = fs.readFileSync(transcriptPath, 'utf8');
                const stats = fs.statSync(transcriptPath);

                res.json({
                    id: transcriptId,
                    content: content,
                    timestamp: stats.mtime.getTime()
                });
            } catch (error) {
                logger.error('Error fetching transcript:', error);
                res.status(500).json({ error: 'Failed to fetch transcript' });
            }
        });

        // API endpoint to get summary data
        this.app.get('/api/summary/:id/:type', (req, res) => {
            const { id: transcriptId, type } = req.params;

            // Validate transcript ID to prevent path traversal
            if (!transcriptId || !/^[a-zA-Z0-9_-]+$/.test(transcriptId)) {
                return res.status(400).json({ error: 'Invalid transcript ID' });
            }

            try {
                if (!summarizationService.validateSummaryType(type)) {
                    return res.status(400).json({ error: 'Invalid summary type' });
                }

                if (!summarizationService.summaryExists(transcriptId, type)) {
                    return res.status(404).json({
                        error: 'Summary not found',
                        canGenerate: true,
                        transcriptId: transcriptId,
                        type: type,
                        message: `${type.charAt(0).toUpperCase() + type.slice(1)} summary not found. You can generate it using /summarize command or the transcript viewer.`
                    });
                }

                const summary = summarizationService.getSummary(transcriptId, type);
                const stats = fs.statSync(summary.path);

                res.json({
                    id: transcriptId,
                    type: type,
                    content: summary.content,
                    timestamp: stats.mtime.getTime()
                });
            } catch (error) {
                logger.error('Error fetching summary:', error);
                res.status(500).json({ error: 'Failed to fetch summary' });
            }
        });

        // API endpoint to generate summary
        this.app.post('/api/summarize/:id', (req, res) => {
            const transcriptId = req.params.id;
            const { type = 'detailed' } = req.body;

            // Validate transcript ID to prevent path traversal
            if (!transcriptId || !/^[a-zA-Z0-9_-]+$/.test(transcriptId)) {
                return res.status(400).json({ error: 'Invalid transcript ID' });
            }

            try {
                if (!summarizationService.validateSummaryType(type)) {
                    return res.status(400).json({ error: 'Invalid summary type' });
                }

                const transcriptPath = path.join(config.paths.recordings, `transcript_${transcriptId}.md`);

                if (!fs.existsSync(transcriptPath)) {
                    return res.status(404).json({ error: 'Transcript not found' });
                }

                // Check if summary already exists
                if (summarizationService.summaryExists(transcriptId, type)) {
                    const savedSummary = {
                        fileName: `${transcriptId}_summary_${type}.md`
                    };

                    return res.json({
                        id: transcriptId,
                        type: type,
                        downloadUrl: this.createTemporaryUrl(savedSummary.fileName),
                        viewUrl: `/summary?id=${transcriptId}&type=${type}`,
                        cached: true
                    });
                }

                // Generate summary asynchronously
                summarizationService.summarizeTranscript(transcriptPath, type)
                    .then(summaryResult => {
                        // Save summary to file
                        return summarizationService.saveSummary(summaryResult, transcriptId, type);
                    })
                    .then(savedSummary => {
                        res.json({
                            id: transcriptId,
                            type: type,
                            downloadUrl: this.createTemporaryUrl(savedSummary.fileName),
                            viewUrl: `/summary?id=${transcriptId}&type=${type}`
                        });
                    })
                    .catch(error => {
                        logger.error('Error generating summary:', error);
                        res.status(500).json({ error: 'Failed to generate summary' });
                    });
            } catch (error) {
                logger.error('Error in summarize endpoint:', error);
                res.status(500).json({ error: 'Failed to generate summary' });
            }
        });

        // Download endpoint with temporary URLs
        this.app.get('/download/:token', (req, res) => {
            const token = req.params.token;

            // Check if token exists and is valid
            const urlInfo = this.temporaryUrls.get(token);
            if (!urlInfo) {
                return res.status(404).json({ error: 'Invalid or expired download link' });
            }

            // Check if token has expired
            if (Date.now() > urlInfo.expires) {
                this.temporaryUrls.delete(token);
                return res.status(404).json({ error: 'Download link has expired' });
            }

            const filename = urlInfo.filename;
            const filePath = fileManager.getFilePath(filename);

            if (!fileManager.fileExists(filename)) {
                this.temporaryUrls.delete(token);
                return res.status(404).json({ error: 'File not found' });
            }

            try {
                const stat = fs.statSync(filePath);

                res.setHeader('Content-Type', 'audio/mpeg');
                res.setHeader('Content-Length', stat.size);
                res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

                const readStream = fs.createReadStream(filePath);
                readStream.pipe(res);

                readStream.on('error', (error) => {
                    logger.error('Error serving file:', error);
                    res.status(500).json({ error: 'Failed to serve file' });
                });

            } catch (error) {
                logger.error('Error accessing file:', error);
                res.status(500).json({ error: 'Failed to access file' });
            }
        });

        // List recordings endpoint (generates temporary URLs)
        this.app.get('/recordings', (req, res) => {
            try {
                const recordings = fileManager.getAllRecordings();
                res.json({
                    recordings: recordings.map(rec => ({
                        name: rec.name,
                        size: rec.size,
                        created: rec.created,
                        downloadUrl: this.createTemporaryUrl(rec.name)
                    })),
                    totalCount: recordings.length
                });
            } catch (error) {
                logger.error('Error listing recordings:', error);
                res.status(500).json({ error: 'Failed to list recordings' });
            }
        });

        // Disk usage endpoint
        this.app.get('/stats', (req, res) => {
            try {
                const diskUsage = fileManager.getDiskUsage();
                res.json({
                    diskUsage,
                    uptime: process.uptime(),
                    memory: process.memoryUsage()
                });
            } catch (error) {
                logger.error('Error getting stats:', error);
                res.status(500).json({ error: 'Failed to get stats' });
            }
        });

        // Error handling
        this.app.use((err, req, res, _next) => {
            logger.error('Express error:', err);
            res.status(500).json({ error: 'Internal server error' });
        });

        // Serve React frontend static files
        this.app.use(express.static(path.join(__dirname, '../..', 'public')));

        // Serve React app for root route
        this.app.get('/', (req, res) => {
            res.sendFile(path.join(__dirname, '../..', 'public', 'index.html'));
        });

        // Serve React app for summary viewer route
        this.app.get('/summary', (req, res) => {
            res.sendFile(path.join(__dirname, '../..', 'public', 'index.html'));
        });

        // 404 handler
        this.app.use((req, res) => {
            res.status(404).json({ error: 'Not found' });
        });
    }

    start() {
        const port = config.express.port;

        this.server = this.app.listen(port, '0.0.0.0', () => {
            logger.info(`Express server started on port ${port}`);
            logger.info(`Download URL: ${config.express.baseUrl}/download/[token]`);
        });

        return this.server;
    }

    stop() {
        if (this.server) {
            this.server.close();
            logger.info('Express server stopped');
        }
    }

    // Create a temporary obscured URL for a file
    createTemporaryUrl(filename) {
        const token = crypto.randomBytes(32).toString('hex');
        const expires = Date.now() + config.security.temporaryUrlExpiry;

        this.temporaryUrls.set(token, {
            filename: filename,
            expires: expires
        });

        return `${config.express.baseUrl}/download/${token}`;
    }

    // Clean up expired URLs periodically
    cleanupExpiredUrls() {
        const cleanup = () => {
            const now = Date.now();
            for (const [token, urlInfo] of this.temporaryUrls.entries()) {
                if (now > urlInfo.expires) {
                    this.temporaryUrls.delete(token);
                }
            }
        };

        // Run cleanup every hour
        setInterval(cleanup, 60 * 60 * 1000);
    }
}

module.exports = ExpressServer;
