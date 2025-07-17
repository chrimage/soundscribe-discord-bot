const fs = require('fs');
const path = require('path');
const config = require('../config');
const logger = require('./logger');

class FileManager {
    constructor() {
        this.recordingsDir = config.paths.recordings;
        this.tempDir = config.paths.temp;
        
        // Ensure directories exist
        this.ensureDirectories();
        
        // Start cleanup interval (every hour)
        this.startCleanupInterval();
    }

    ensureDirectories() {
        if (!fs.existsSync(this.recordingsDir)) {
            fs.mkdirSync(this.recordingsDir, { recursive: true });
            logger.info(`Created recordings directory: ${this.recordingsDir}`);
        }
        
        if (!fs.existsSync(this.tempDir)) {
            fs.mkdirSync(this.tempDir, { recursive: true });
            logger.info(`Created temp directory: ${this.tempDir}`);
        }
    }

    async getLatestRecording() {
        try {
            const files = fs.readdirSync(this.recordingsDir)
                .filter(file => file.endsWith('.mp3'))
                .map(file => {
                    const filePath = path.join(this.recordingsDir, file);
                    const stats = fs.statSync(filePath);
                    return {
                        name: file,
                        path: filePath,
                        size: stats.size,
                        created: stats.birthtime
                    };
                })
                .sort((a, b) => b.created - a.created);

            return files[0] || null;
        } catch (error) {
            logger.error('Error getting latest recording:', error);
            return null;
        }
    }

    async getAllRecordings() {
        try {
            return fs.readdirSync(this.recordingsDir)
                .filter(file => file.endsWith('.mp3'))
                .map(file => {
                    const filePath = path.join(this.recordingsDir, file);
                    const stats = fs.statSync(filePath);
                    return {
                        name: file,
                        path: filePath,
                        size: stats.size,
                        created: stats.birthtime
                    };
                });
        } catch (error) {
            logger.error('Error getting recordings:', error);
            return [];
        }
    }

    async deleteOldFiles() {
        const maxAge = 24 * 60 * 60 * 1000; // 24 hours in milliseconds
        const now = Date.now();
        let deletedCount = 0;

        try {
            // Clean up recordings directory
            const recordings = await this.getAllRecordings();
            for (const recording of recordings) {
                if (now - recording.created.getTime() > maxAge) {
                    fs.unlinkSync(recording.path);
                    logger.info(`Deleted old recording: ${recording.name}`);
                    deletedCount++;
                }
            }

            // Clean up temp directory
            if (fs.existsSync(this.tempDir)) {
                const tempFiles = fs.readdirSync(this.tempDir);
                for (const file of tempFiles) {
                    const filePath = path.join(this.tempDir, file);
                    try {
                        const stats = fs.statSync(filePath);
                        if (now - stats.birthtime.getTime() > maxAge) {
                            if (stats.isDirectory()) {
                                // Recursively delete directory and its contents
                                fs.rmSync(filePath, { recursive: true, force: true });
                                logger.info(`Deleted old temp directory: ${file}`);
                            } else {
                                // Delete file
                                fs.unlinkSync(filePath);
                                logger.info(`Deleted old temp file: ${file}`);
                            }
                            deletedCount++;
                        }
                    } catch (error) {
                        logger.error(`Error deleting temp item ${file}:`, error);
                        // Continue with other files
                    }
                }
            }

            if (deletedCount > 0) {
                logger.info(`Cleanup completed: deleted ${deletedCount} old files`);
            }

            return deletedCount;
        } catch (error) {
            logger.error('Error during cleanup:', error);
            return 0;
        }
    }

    startCleanupInterval() {
        // Run cleanup every hour
        setInterval(() => {
            this.deleteOldFiles();
        }, 60 * 60 * 1000);

        // Run cleanup on startup
        this.deleteOldFiles();
    }

    getDiskUsage() {
        try {
            const recordings = this.getAllRecordings();
            const totalSize = recordings.reduce((sum, file) => sum + file.size, 0);
            
            return {
                fileCount: recordings.length,
                totalSize,
                totalSizeMB: Math.round(totalSize / 1024 / 1024 * 100) / 100
            };
        } catch (error) {
            logger.error('Error getting disk usage:', error);
            return { fileCount: 0, totalSize: 0, totalSizeMB: 0 };
        }
    }

    getFilePath(filename) {
        return path.join(this.recordingsDir, filename);
    }

    fileExists(filename) {
        return fs.existsSync(path.join(this.recordingsDir, filename));
    }
}

module.exports = new FileManager();