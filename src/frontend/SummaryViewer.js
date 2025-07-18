import React, { useState } from 'react';
import ReactMarkdown from 'react-markdown';

const SummaryViewer = ({ summary }) => {
    const [copySuccess, setCopySuccess] = useState(false);

    const downloadSummary = () => {
        const element = document.createElement('a');
        const file = new Blob([summary.content], { type: 'text/markdown' });
        element.href = URL.createObjectURL(file);
        element.download = `summary_${summary.id}_${summary.type}.md`;
        document.body.appendChild(element);
        element.click();
        document.body.removeChild(element);
    };

    const copyToClipboard = async () => {
        try {
            await navigator.clipboard.writeText(summary.content);
            setCopySuccess(true);
            setTimeout(() => setCopySuccess(false), 2000);
        } catch (err) {
            console.error('Failed to copy text: ', err);
        }
    };

    const formatDate = (timestamp) => {
        return new Date(timestamp).toLocaleString();
    };

    const getSummaryTypeDisplay = (type) => {
        switch (type) {
            case 'brief':
                return 'Brief Summary';
            case 'detailed':
                return 'Detailed Summary';
            case 'key_points':
                return 'Key Points';
            default:
                return 'Summary';
        }
    };

    return (
        <div className="summary-viewer">
            <div className="summary-header">
                <div className="summary-info">
                    <h2>{getSummaryTypeDisplay(summary.type)}</h2>
                    <p className="summary-meta">
            Transcript ID: {summary.id} |
            Type: {summary.type} |
            Generated: {formatDate(summary.timestamp)}
                    </p>
                </div>
                <div className="summary-actions">
                    <button onClick={downloadSummary} className="btn btn-primary">
            📥 Download
                    </button>
                    <button onClick={copyToClipboard} className="btn btn-secondary">
                        {copySuccess ? '✅ Copied!' : '📋 Copy'}
                    </button>
                </div>
            </div>

            <div className="summary-content">
                <ReactMarkdown>{summary.content}</ReactMarkdown>
            </div>
        </div>
    );
};

export default SummaryViewer;
