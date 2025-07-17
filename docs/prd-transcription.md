# Product Requirements Document: AI Transcription Feature

## Overview
Add AI-powered transcription capabilities to the SoundScribe Discord bot, enabling automatic generation of speaker-diarized transcripts from voice channel recordings.

## Problem Statement
We need written records of our Discord voice conversations for reference, note-taking, accessibility, and archival purposes. Manual transcription is time-consuming and doesn't scale for frequent voice discussions.

## Solution
Implement an automated transcription system that processes individual user audio streams to create timestamped, speaker-labeled transcripts using Whisper STT technology.

---

## Functional Requirements (FRs)

### FR1: Audio Stream Processing & Segmentation
- **FR1.1**: Extend existing per-user PCM stream recording to include speech activity detection
- **FR1.2**: Implement energy/amplitude thresholding for speech detection (simple RMS-based approach)
- **FR1.3**: Create temporal segments with start/end timestamps based on speech activity
- **FR1.4**: Store segment metadata (user ID, start time, end time, audio file path)
- **FR1.5**: Handle audio format conversion for Whisper compatibility (PCM to WAV/MP3)

### FR2: Speaker Diarization & Timeline Management
- **FR2.1**: Map Discord user IDs to server display names for transcript labeling
- **FR2.2**: Create unified timeline from all user segments using packet receipt timestamps
- **FR2.3**: Implement overlap resolution by micro-adjusting segment timestamps ("nudging")
- **FR2.4**: Maintain chronological ordering of all speech segments across users
- **FR2.5**: Handle edge cases (late joiners, early leavers, silent periods)

### FR3: Whisper STT Integration
- **FR3.1**: Create modular `TranscriptionProcessor` class for STT operations
- **FR3.2**: Implement batch processing for audio segments with queue management
- **FR3.3**: Add retry logic with exponential backoff for API failures
- **FR3.4**: Handle rate limiting and API cost management
- **FR3.5**: Process transcription results and extract confidence scores when available
- **FR3.6**: Support both OpenAI Whisper API and local Whisper model deployment

### FR4: Transcript Assembly & Formatting
- **FR4.1**: Assemble final transcript in chronological order with speaker attribution
- **FR4.2**: Format transcript with timestamps, speaker labels, and confidence indicators
- **FR4.3**: Generate metadata header (date, participants, duration, processing info)
- **FR4.4**: Support multiple output formats (plain text, markdown, structured JSON)
- **FR4.5**: Handle partial transcription failures gracefully (mark missing segments)

### FR5: Async Job Management & User Interface
- **FR5.1**: Add `/transcribe` command with async job processing
- **FR5.2**: Implement job queue system for concurrent transcription requests
- **FR5.3**: Provide real-time progress updates during processing
- **FR5.4**: Generate secure download links for completed transcripts
- **FR5.5**: Add `/transcribe_status` command to check job progress
- **FR5.6**: Handle command errors with detailed, actionable error messages

### FR6: File Management & Storage
- **FR6.1**: Extend existing file cleanup system to include transcript files
- **FR6.2**: Store intermediate processing files (segments, metadata) temporarily
- **FR6.3**: Implement transcript file serving through existing Express server
- **FR6.4**: Add transcript file retention policies (configurable cleanup schedule)

---

## Non-Functional Requirements (NFRs)

### NFR1: Performance & Resource Management
- **NFR1.1**: Process transcription within reasonable time (target: <10 minutes for 1-hour recording)
- **NFR1.2**: Use lightweight speech detection to minimize CPU overhead
- **NFR1.3**: Implement job queuing to prevent resource exhaustion
- **NFR1.4**: Support configurable concurrency limits for Whisper requests
- **NFR1.5**: Clean up temporary files automatically after processing

### NFR2: Reliability & Error Handling
- **NFR2.1**: Gracefully handle Whisper API failures with detailed error reporting
- **NFR2.2**: Provide best-effort transcripts even with partial failures
- **NFR2.3**: Implement comprehensive logging for debugging transcription issues
- **NFR2.4**: Handle poor audio quality with appropriate user warnings
- **NFR2.5**: Recover from bot restarts without losing job progress

### NFR3: Scalability & Deployment
- **NFR3.1**: Support recordings with up to 10 concurrent speakers
- **NFR3.2**: Handle recordings up to 2 hours in length
- **NFR3.3**: Design for both API-based and local Whisper deployment
- **NFR3.4**: Implement configurable resource limits based on deployment constraints
- **NFR3.5**: Support horizontal scaling through job queue architecture

### NFR4: Maintainability & Code Quality
- **NFR4.1**: Modularize transcription logic to minimize impact on existing codebase
- **NFR4.2**: Provide clear configuration options for different deployment scenarios
- **NFR4.3**: Include comprehensive unit tests for transcription components
- **NFR4.4**: Document API integration patterns and error handling strategies

---

## User Stories

### Epic: Basic Transcription
**As a** team member  
**I want** to generate transcripts of voice conversations  
**So that** I can reference what was discussed without re-listening to audio

#### Story 1: Request Transcript Processing
**As a** team member who just finished a recorded voice call  
**I want** to use a `/transcribe` command  
**So that** I can initiate processing of our conversation transcript  

**Acceptance Criteria:**
- Command immediately responds with job ID and estimated processing time
- System queues the transcription job without blocking other bot operations
- Progress updates are provided during processing
- User receives notification when processing completes

#### Story 2: Monitor Processing Status
**As a** team member who requested transcription  
**I want** to check processing status  
**So that** I know when my transcript will be ready  

**Acceptance Criteria:**
- `/transcribe_status` command shows current job progress
- Status includes estimated completion time
- Error states are clearly communicated
- Completed jobs provide download links

#### Story 3: Download Transcript
**As a** team member whose transcript is ready  
**I want** to download the transcript file  
**So that** I can save it locally or share with others  

**Acceptance Criteria:**
- Download link works reliably through existing file server
- File format is readable (markdown with metadata)
- File includes processing metadata and confidence indicators
- Link remains valid for configured retention period

### Epic: Speaker Identification
**As a** team member  
**I want** transcripts to clearly identify who said what  
**So that** I can attribute statements to specific participants

#### Story 4: Accurate Speaker Attribution
**As a** team member reviewing a transcript  
**I want** to see who spoke each segment  
**So that** I can follow the conversation flow  

**Acceptance Criteria:**
- Each speech segment shows speaker's Discord display name
- Speaker changes are clearly marked in transcript
- Overlapping speech is handled with temporal nudging
- Unknown or system issues are labeled appropriately

#### Story 5: Chronological Accuracy
**As a** team member reviewing a transcript  
**I want** speech segments in correct time order  
**So that** the transcript reflects actual conversation flow  

**Acceptance Criteria:**
- All segments appear in chronological order
- Overlapping speech doesn't break timeline
- Brief pauses don't create unnecessary fragmentation
- Late joiners/early leavers are handled gracefully

### Epic: Quality & Error Handling
**As a** team member  
**I want** transcription to work reliably  
**So that** I can depend on the feature for important conversations

#### Story 6: Graceful Error Management
**As a** team member requesting transcription  
**I want** clear feedback when something goes wrong  
**So that** I understand what happened and can take appropriate action  

**Acceptance Criteria:**
- Network/API errors are communicated clearly
- Partial failures still produce usable transcripts with warnings
- Retry options are provided for recoverable errors
- System remains stable even with processing failures

#### Story 7: Audio Quality Handling
**As a** team member receiving transcripts  
**I want** poor audio quality to be handled appropriately  
**So that** I get the best possible transcript with clear quality indicators  

**Acceptance Criteria:**
- Low-confidence segments are marked in transcript
- Very poor audio generates helpful warnings
- System provides best-effort transcription even with quality issues
- Quality metrics are included in transcript metadata

---

## Technical Architecture

### Core Components

#### 1. Audio Segment Processor
- Extends existing PCM recording system
- Implements energy-based speech detection
- Handles audio format conversion for Whisper
- Manages segment metadata and file storage

#### 2. Transcription Job Manager
- Implements async job queue system
- Manages Whisper API integration and rate limiting
- Handles job progress tracking and status updates
- Provides retry logic and error recovery

#### 3. Timeline Assembly Engine
- Creates unified timeline from multi-user segments
- Implements overlap resolution through timestamp nudging
- Maintains chronological ordering across all speakers
- Handles edge cases (joins/leaves, silence periods)

#### 4. Transcript Formatter
- Assembles final transcript with speaker attribution
- Supports multiple output formats (text, markdown, JSON)
- Includes metadata and confidence indicators
- Handles partial transcription results gracefully

### Integration Points
- Existing Discord bot command framework
- Current audio recording and PCM processing pipeline
- File serving infrastructure (Express server)
- Audio cleanup and retention system

### Deployment Considerations
- **API-based Whisper**: Requires OpenAI API key, handles rate limiting
- **Local Whisper**: Requires GPU resources, self-contained processing
- **Hybrid approach**: Fallback from local to API based on load

---

## Success Metrics

### Primary Success Criteria
- **Feature Implementation**: Successfully deployed and operational
- **Integration Quality**: Minimal disruption to existing bot functionality
- **User Experience**: Clear commands and reliable file delivery

### Secondary Success Criteria
- **Processing Performance**: <10 minutes for 1-hour recordings
- **Transcription Quality**: >85% accuracy for clear speech
- **System Reliability**: <5% job failure rate
- **Resource Efficiency**: Manageable CPU/memory usage during processing

---

## Risk Mitigation

### Technical Risks
- **Audio Quality Issues**: Implement quality detection and user warnings
- **API Rate Limiting**: Add queue management and retry logic
- **Resource Constraints**: Implement configurable limits and monitoring
- **Integration Complexity**: Modularize components to minimize codebase impact

### Operational Risks
- **Cost Management**: Monitor API usage and implement usage limits
- **Storage Growth**: Extend existing cleanup policies to transcript files
- **User Expectations**: Clearly communicate processing times and limitations
- **Deployment Complexity**: Support both API and local deployment options

---

## Future Enhancements

### Phase 2 Features
- **Speaker Name Mapping**: Allow custom speaker name aliases
- **Transcript Search**: Index transcripts for keyword search
- **Summary Generation**: AI-powered conversation summaries
- **Export Options**: Integration with note-taking tools

### Long-term Vision
- **Real-time Transcription**: Live transcription during calls
- **Multi-language Support**: Automatic language detection
- **Advanced Diarization**: Acoustic speaker identification
- **Analytics Dashboard**: Usage and quality metrics visualization
