const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const config = require('../config');
const logger = require('../utils/logger');
const fileManager = require('../utils/fileManager');

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
        this.app.use((err, req, res, next) => {
            logger.error('Express error:', err);
            res.status(500).json({ error: 'Internal server error' });
        });

        // 404 handler
        this.app.use((req, res) => {
            res.status(404).json({ error: 'Not found' });
        });
    }

    start() {
        const port = config.express.port;
        
        this.server = this.app.listen(port, () => {
            logger.info(`Express server started on port ${port}`);
            logger.info(`Download URL: ${config.express.baseUrl}/download/:filename`);
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