import React, { useState } from 'react';
import ReactMarkdown from 'react-markdown';

const TranscriptViewer = ({ transcript }) => {
  const [copySuccess, setCopySuccess] = useState(false);

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
      
      <div className="transcript-content">
        <ReactMarkdown>{transcript.content}</ReactMarkdown>
      </div>
    </div>
  );
};

export default TranscriptViewer;