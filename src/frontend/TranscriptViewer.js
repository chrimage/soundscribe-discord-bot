import React, { useState } from 'react';
import ReactMarkdown from 'react-markdown';

const TranscriptViewer = ({ transcript }) => {
    const [copySuccess, setCopySuccess] = useState(false);
    const [summaryGenerating, setSummaryGenerating] = useState(false);
    const [summaryError, setSummaryError] = useState(null);

    const downloadTranscript = () => {
        const element = document.createElement('a');
        const file = new Blob([transcript.content], { type: 'text/markdown' });
        element.href = URL.createObjectURL(file);
        element.download = `transcript_${transcript.id}.md`;
        document.body.appendChild(element);
        element.click();
        document.body.removeChild(element);
    };

    const copyToClipboard = async () => {
        try {
            await navigator.clipboard.writeText(transcript.content);
            setCopySuccess(true);
            setTimeout(() => setCopySuccess(false), 2000);
        } catch (err) {
            console.error('Failed to copy text: ', err);
        }
    };

    const formatDate = (timestamp) => {
        return new Date(timestamp).toLocaleString();
    };

    const generateSummary = async (type) => {
        setSummaryGenerating(true);
        setSummaryError(null);

        try {
            const response = await fetch(`/api/summarize/${transcript.id}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ type })
            });

            if (!response.ok) {
                throw new Error('Failed to generate summary');
            }

            const data = await response.json();

            // Redirect to summary viewer
            window.location.href = data.viewUrl;

        } catch (error) {
            setSummaryError(error.message);
        } finally {
            setSummaryGenerating(false);
        }
    };

    return (
        <div className="transcript-viewer">
            <div className="transcript-header">
                <div className="transcript-info">
                    <h2>Transcript</h2>
                    <p className="transcript-meta">
            Recording ID: {transcript.id} |
            Created: {formatDate(transcript.timestamp)}
                    </p>
                </div>
                <div className="transcript-actions">
                    <button onClick={downloadTranscript} className="btn btn-primary">
            📥 Download
                    </button>
                    <button onClick={copyToClipboard} className="btn btn-secondary">
                        {copySuccess ? '✅ Copied!' : '📋 Copy'}
                    </button>
                </div>
            </div>

            <div className="summary-section">
                <h3>Generate Summary</h3>
                <div className="summary-buttons">
                    <button
                        onClick={() => generateSummary('brief')}
                        className="btn btn-outline"
                        disabled={summaryGenerating}
                    >
                        {summaryGenerating ? '⏳ Generating...' : '📝 Brief Summary'}
                    </button>
                    <button
                        onClick={() => generateSummary('detailed')}
                        className="btn btn-outline"
                        disabled={summaryGenerating}
                    >
                        {summaryGenerating ? '⏳ Generating...' : '📖 Detailed Summary'}
                    </button>
                    <button
                        onClick={() => generateSummary('key_points')}
                        className="btn btn-outline"
                        disabled={summaryGenerating}
                    >
                        {summaryGenerating ? '⏳ Generating...' : '🎯 Key Points'}
                    </button>
                </div>
                {summaryError && (
                    <div className="error-message">
            Error: {summaryError}
                    </div>
                )}
            </div>

            <div className="transcript-content">
                <ReactMarkdown>{transcript.content}</ReactMarkdown>
            </div>
        </div>
    );
};

export default TranscriptViewer;
