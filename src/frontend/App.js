import React, { useState, useEffect } from 'react';
import TranscriptViewer from './TranscriptViewer';
import SummaryViewer from './SummaryViewer';
import './styles.css';

const App = () => {
    const [content, setContent] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [viewMode, setViewMode] = useState('transcript'); // 'transcript' or 'summary'

    useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        const transcriptId = params.get('id');
        const summaryType = params.get('type');
        const pathname = window.location.pathname;

        if (pathname === '/summary' && transcriptId && summaryType) {
            setViewMode('summary');
            fetchSummary(transcriptId, summaryType);
        } else if (transcriptId) {
            setViewMode('transcript');
            fetchTranscript(transcriptId);
        } else {
            setError('No transcript ID provided');
            setLoading(false);
        }
    }, []);

    const fetchTranscript = async (id) => {
        try {
            const response = await fetch(`/api/transcript/${id}`);
            if (!response.ok) {
                throw new Error('Failed to fetch transcript');
            }
            const data = await response.json();
            setContent(data);
        } catch (err) {
            setError(err.message);
        } finally {
            setLoading(false);
        }
    };

    const fetchSummary = async (id, type) => {
        try {
            const response = await fetch(`/api/summary/${id}/${type}`);
            if (!response.ok) {
                const errorData = await response.json();
                if (response.status === 404 && errorData.canGenerate) {
                    // Summary doesn't exist but can be generated
                    setError(`${errorData.message}\n\nYou can generate this summary by:\n1. Going to the transcript viewer\n2. Using the /summarize command in Discord\n3. Clicking the "Generate Summary" button`);
                } else {
                    throw new Error(errorData.message || 'Failed to fetch summary');
                }
                return;
            }
            const data = await response.json();
            setContent(data);
        } catch (err) {
            setError(err.message);
        } finally {
            setLoading(false);
        }
    };

    if (loading) {
        return (
            <div className="app">
                <div className="loading">Loading {viewMode}...</div>
            </div>
        );
    }

    if (error) {
        const params = new URLSearchParams(window.location.search);
        const transcriptId = params.get('id');
        const showTranscriptLink = viewMode === 'summary' && transcriptId;

        return (
            <div className="app">
                <header className="header">
                    <h1>SoundScribe</h1>
                    <p>Error Loading Content</p>
                </header>
                <main className="main">
                    <div className="error">
                        <div className="error-content">
                            <h2>⚠️ Error</h2>
                            <p>{error}</p>
                            {showTranscriptLink && (
                                <div className="error-actions">
                                    <a href={`/?id=${transcriptId}`} className="btn btn-primary">
                    📄 View Transcript
                                    </a>
                                </div>
                            )}
                        </div>
                    </div>
                </main>
            </div>
        );
    }

    return (
        <div className="app">
            <header className="header">
                <h1>SoundScribe</h1>
                <p>{viewMode === 'summary' ? 'Summary Viewer' : 'Voice Transcript Viewer'}</p>
            </header>
            <main className="main">
                {viewMode === 'summary' ? (
                    <SummaryViewer summary={content} />
                ) : (
                    <TranscriptViewer transcript={content} />
                )}
            </main>
        </div>
    );
};

export default App;
