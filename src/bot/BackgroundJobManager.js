const { WebhookClient } = require('discord.js');
const path = require('path');
const fs = require('fs');
const logger = require('../utils/logger');
const transcriptionService = require('../services/TranscriptionService');
const summarizationService = require('../services/SummarizationService');
const titleGenerationService = require('../services/TitleGenerationService');
const config = require('../config');

class BackgroundJobManager {
    constructor(expressServer) {
        this.expressServer = expressServer;
        this.jobs = new Map();
        this.jobCounter = 0;
        this.jobsFile = path.join(config.paths.temp, 'background_jobs.json');
        
        // Load existing jobs on startup
        this.loadJobs();
        
        // Save jobs periodically
        this.setupPeriodicSave();
    }

    loadJobs() {
        try {
            if (fs.existsSync(this.jobsFile)) {
                const data = fs.readFileSync(this.jobsFile, 'utf8');
                const jobsData = JSON.parse(data);
                
                this.jobCounter = jobsData.counter || 0;
                
                // Restore jobs but mark incomplete ones as failed
                for (const [jobId, jobData] of Object.entries(jobsData.jobs || {})) {
                    if (jobData.status === 'processing' || jobData.status === 'queued') {
                        jobData.status = 'failed';
                        jobData.error = 'Job interrupted by restart';
                    }
                    this.jobs.set(parseInt(jobId), jobData);
                }
                
                logger.info(`Loaded ${this.jobs.size} persisted background jobs`);
            }
        } catch (error) {
            logger.error('Failed to load persisted jobs:', error);
        }
    }

    saveJobs() {
        try {
            const jobsData = {
                counter: this.jobCounter,
                jobs: Object.fromEntries(this.jobs),
                savedAt: new Date().toISOString()
            };
            
            fs.writeFileSync(this.jobsFile, JSON.stringify(jobsData, null, 2));
        } catch (error) {
            logger.error('Failed to save jobs:', error);
        }
    }

    setupPeriodicSave() {
        // Save jobs every 30 seconds
        setInterval(() => {
            if (this.jobs.size > 0) {
                this.saveJobs();
            }
        }, 30000);
    }

    queueTranscription(jobData) {
        const jobId = ++this.jobCounter;
        const job = { ...jobData, status: 'queued', startTime: Date.now() };
        this.jobs.set(jobId, job);
        
        // Save immediately for new jobs
        this.saveJobs();
        
        logger.info(`Queued transcription job ${jobId} for recording ${jobData.recordingId}`);
        
        // Process in background (don't await)
        this.processTranscription(jobId, jobData).catch(error => {
            logger.error(`Background transcription job ${jobId} failed:`, error);
            const job = this.jobs.get(jobId);
            if (job) {
                job.status = 'failed';
                job.error = error.message;
                this.saveJobs();
            }
        });
        
        return jobId;
    }

    getJobStatus(jobId) {
        return this.jobs.get(jobId) || null;
    }

    async processTranscription(jobId, { recordingData, processedResult, interactionToken, webhookUrl, recordingId }) {
        const job = this.jobs.get(jobId);
        if (!job) return;

        try {
            job.status = 'processing';
            logger.info(`Starting transcription job ${jobId}`);

            // Create webhook client for updating the original message
            const webhook = new WebhookClient({ url: webhookUrl });

            // Update status: "Transcribing..."
            await this.updateProgress(webhook, interactionToken, 
                this.buildProgressResponse(processedResult, "🤖 Transcribing speech segments..."));

            // Transcribe speech segments
            const transcriptionResults = await transcriptionService.transcribeSpeechSegments(
                recordingData.speechSegments,
                recordingData.userFiles
            );
            const transcript = transcriptionService.formatTranscript(transcriptionResults);

            // Save transcript to file
            const transcriptFilename = `transcript_${recordingId}.md`;
            const transcriptPath = path.join(config.paths.recordings, transcriptFilename);
            require('fs').writeFileSync(transcriptPath, transcript.text);

            // Update status: "Generating title..."
            await this.updateProgress(webhook, interactionToken,
                this.buildProgressResponse(processedResult, "📝 Generating title and summary..."));

            // Generate title and brief summary
            let generatedTitle = null;
            let briefSummary = null;

            try {
                // Generate title
                const titleResult = await titleGenerationService.generateTitle(transcript.text);
                await titleGenerationService.saveTitle(titleResult, recordingId);
                generatedTitle = titleResult;
                logger.info(`Generated title for job ${jobId}: "${titleResult.title}"`);

                // Generate brief summary
                const summaryResult = await summarizationService.summarizeTranscript(transcriptPath, 'brief');
                briefSummary = summaryResult.summary;
                logger.info(`Generated brief summary for job ${jobId}`);

            } catch (titleError) {
                logger.error(`Failed to generate title/summary for job ${jobId}:`, {
                    error: titleError.message,
                    stack: titleError.stack,
                    jobId: jobId
                });
                // Generate fallback title
                try {
                    const fallbackTitle = titleGenerationService.generateFallbackTitle(recordingId);
                    await titleGenerationService.saveTitle(fallbackTitle, recordingId);
                    generatedTitle = fallbackTitle;
                } catch (fallbackError) {
                    logger.error(`Failed to generate fallback title for job ${jobId}:`, fallbackError);
                }
            }

            // Create final response with all results
            const transcriptUrl = this.expressServer.createTemporaryUrl(transcriptFilename);
            const webViewerUrl = this.createTranscriptViewerLink(transcriptFilename);
            const detailedSummaryUrl = `${config.express.baseUrl}/summary?id=${recordingId}&type=detailed`;

            const finalResponse = this.buildCompletedResponse(
                processedResult,
                transcript,
                {
                    transcriptUrl,
                    webViewerUrl,
                    detailedSummaryUrl,
                    generatedTitle,
                    briefSummary,
                    recordingData
                }
            );

            // Final update with complete results
            await webhook.editMessage('@original', { content: finalResponse });

            job.status = 'completed';
            job.completedTime = Date.now();
            logger.info(`Completed transcription job ${jobId} in ${job.completedTime - job.startTime}ms`);

            // Clean up job after 1 hour
            setTimeout(() => this.jobs.delete(jobId), 60 * 60 * 1000);

        } catch (error) {
            job.status = 'failed';
            job.error = error.message;
            logger.error(`Transcription job ${jobId} failed:`, error);

            try {
                const webhook = new WebhookClient({ url: webhookUrl });
                await webhook.editMessage('@original', {
                    content: this.buildErrorResponse(processedResult, error.message)
                });
            } catch (webhookError) {
                logger.error(`Failed to update failed job ${jobId}:`, webhookError);
            }

            // Clean up failed job after 10 minutes
            setTimeout(() => this.jobs.delete(jobId), 10 * 60 * 1000);
        }
    }

    async updateProgress(webhook, interactionToken, content) {
        try {
            // Use '@original' to edit the original interaction response
            await webhook.editMessage('@original', { content });
        } catch (error) {
            logger.warn('Failed to update job progress:', error.message);
        }
    }

    buildProgressResponse(processedResult, statusMessage) {
        const downloadUrl = this.expressServer.createTemporaryUrl(path.basename(processedResult.outputFile));
        const fileSizeMB = Math.round(processedResult.fileSize / 1024 / 1024 * 100) / 100;

        return '🎙️ **Recording Complete!**\n\n' +
               '🔗 **Audio Recording:**\n' +
               `• 🎵 [Download MP3](${downloadUrl}) (${fileSizeMB} MB)\n\n` +
               `${statusMessage}\n\n` +
               '⚠️ *Files expire in 24 hours*';
    }

    buildCompletedResponse(processedResult, transcript, extras) {
        const downloadUrl = this.expressServer.createTemporaryUrl(path.basename(processedResult.outputFile));
        const fileSizeMB = Math.round(processedResult.fileSize / 1024 / 1024 * 100) / 100;
        const durationMinutes = Math.round(extras.recordingData.duration / 60000);

        let response = '🎙️ **Recording Complete!**\n\n';

        // Add title if available
        if (extras.generatedTitle) {
            response += `📝 **"${extras.generatedTitle.title}"**\n\n`;
        }

        // Add summary if available
        if (extras.briefSummary) {
            const maxSummaryLength = 800;
            const displaySummary = extras.briefSummary.length > maxSummaryLength
                ? extras.briefSummary.substring(0, maxSummaryLength) + '...'
                : extras.briefSummary;
            response += `📋 **Summary:**\n${displaySummary}\n\n`;
        }

        response += '🔗 **Links:**\n';
        response += `• 🎵 [Audio Recording](${downloadUrl})\n`;
        response += `• 📄 [Transcript](${extras.webViewerUrl}) | [Download](${extras.transcriptUrl})\n`;
        response += `• 📊 [Detailed Summary](${extras.detailedSummaryUrl})\n\n`;

        response += '📊 **Stats:**\n';
        response += `• Duration: ${durationMinutes} minutes\n`;
        response += `• File size: ${fileSizeMB} MB\n`;
        response += `• Participants: ${transcript.metadata.participants.join(', ')}\n`;
        response += `• Transcribed: ${transcript.metadata.transcribedSegments}/${transcript.metadata.totalSegments} segments\n\n`;

        response += '⚠️ *Files expire in 24 hours*';

        return response;
    }

    buildErrorResponse(processedResult, errorMessage) {
        const downloadUrl = this.expressServer.createTemporaryUrl(path.basename(processedResult.outputFile));
        const fileSizeMB = Math.round(processedResult.fileSize / 1024 / 1024 * 100) / 100;

        return '🎙️ **Recording Complete!**\n\n' +
               '🔗 **Audio Recording:**\n' +
               `• 🎵 [Download MP3](${downloadUrl}) (${fileSizeMB} MB)\n\n` +
               '⚠️ **Transcript:** Generation failed, but you can try /transcribe later\n' +
               `• Error: ${errorMessage}\n\n` +
               '⚠️ *Files expire in 24 hours*';
    }

    createTranscriptViewerLink(transcriptFilename) {
        const recordingId = transcriptFilename.replace('transcript_', '').replace('.md', '');
        return `${config.express.baseUrl}/?id=${recordingId}`;
    }

    getJobStatus(jobId) {
        return this.jobs.get(jobId);
    }

    getAllJobs() {
        return Array.from(this.jobs.entries()).map(([id, job]) => ({ id, ...job }));
    }

    cleanup() {
        // Clean up completed/failed jobs older than 1 hour
        const cutoff = Date.now() - (60 * 60 * 1000);
        for (const [jobId, job] of this.jobs.entries()) {
            if ((job.completedTime && job.completedTime < cutoff) || 
                (job.status === 'failed' && job.startTime < cutoff)) {
                this.jobs.delete(jobId);
            }
        }
    }
}

module.exports = BackgroundJobManager;