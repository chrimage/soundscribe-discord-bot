import React, { useState, useEffect } from 'react';
import TranscriptViewer from './TranscriptViewer';
import './styles.css';

const App = () => {
  const [transcript, setTranscript] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const transcriptId = params.get('id');
    
    if (transcriptId) {
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
      setTranscript(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="app">
        <div className="loading">Loading transcript...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="app">
        <div className="error">Error: {error}</div>
      </div>
    );
  }

  return (
    <div className="app">
      <header className="header">
        <h1>SoundScribe</h1>
        <p>Voice Transcript Viewer</p>
      </header>
      <main className="main">
        <TranscriptViewer transcript={transcript} />
      </main>
    </div>
  );
};

export default App;