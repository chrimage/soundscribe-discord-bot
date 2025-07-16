# SoundScribe MVP Product Requirements Document (PRD)

## 1. Goals and Background Context

### Goals

**Primary Goal:** Successfully implement a bot that can reliably join a voice channel, record audio from all participants, stop on command, and provide a downloadable MP3 file.

**User Goal:** Provide users with a dead-simple way to archive a Discord voice conversation without needing any external software or complex setup.

**Technical Goal:** Validate the core technical approach for audio capture, processing, and delivery within a local Node.js environment, proving viability before adding advanced features.

### Background Context

Discord voice channels are powerful for real-time communication, but their content is ephemeral. Once a conversation ends, valuable discussions, decisions, and creative brainstorming are lost. This makes it difficult for team members to catch up on missed meetings or for communities to archive important events.

SoundScribe aims to solve this by providing a simple, integrated way to capture and retrieve these conversations directly within Discord. This PRD focuses on the **true Minimum Viable Product (MVP)** required to solve the core problem and validate technical feasibility.

### Change Log

| Date | Version | Description | Author |
|------|---------|-------------|--------|
| 2025-07-15 | 2.0 | Major revision: Simplified MVP scope, added missing requirements, risk mitigation | Product Owner |
| 2025-07-15 | 1.4 | Clarified the intent of NFR2 regarding local-first development for the MVP. | John, PM |
| 2025-07-15 | 1.3 | Pivoted technology stack from Python/Pycord to JavaScript/discord.js. | John, PM |
| 2025-07-15 | 1.2 | Updated audio capture/mixing logic to handle dynamic user presence (join/leave). | John, PM |
| 2025-07-15 | 1.1 | Changed /start command to /join. | John, PM |
| 2025-07-15 | 1.0 | Initial PRD creation from Project Brief. | John, PM |

## 2. MVP Scope and Constraints

### What's IN the MVP
- Basic voice recording with simple mixed output
- Three core slash commands (`/join`, `/stop`, `/last_recording`)
- Simple file serving without authentication
- Local file storage
- Basic error handling

### What's OUT of the MVP (Future Phases)
- Individual stream capture and mixing
- JWT-based authentication
- Advanced security features
- Multi-guild support
- Cloud deployment
- Production-grade error recovery

### Technical Risk Mitigation
- **Audio Sync Risk**: Start with single mixed stream capture before attempting individual stream synchronization
- **Memory Risk**: Implement strict recording time limits and monitoring
- **Complexity Risk**: Prioritize working end-to-end flow over advanced features

## 3. Requirements

### Functional Requirements

**FR1:** A `/join` slash command must make the bot join the user's current voice channel and begin recording a mixed audio stream from all participants.

**FR2:** A `/stop` slash command must make the bot stop recording, finalize the audio file, and leave the voice channel.

**FR3:** Upon stopping, the bot must automatically process the recorded audio into a single MP3 file and save it locally.

**FR4:** A `/last_recording` slash command must provide the user with a direct download link to the most recently created audio file.

**FR5:** The download link must be served from a simple web server running as part of the bot's process.

**FR6:** Recording sessions must be limited to a maximum duration of 60 minutes to prevent resource exhaustion.

**FR7:** Only one recording session can be active per Discord guild at a time.

**FR8:** The bot must handle users joining and leaving the voice channel during recording without interrupting the session.

**FR9:** Audio files must be automatically deleted after 24 hours to manage storage space.

**FR10:** The bot must validate that the user is in a voice channel before allowing `/join` command execution.

**FR11:** The bot must prevent duplicate recording sessions (reject `/join` if already recording).

### Non-Functional Requirements

**NFR1:** The application must be developed in JavaScript/Node.js, using discord.js and @discordjs/voice.

**NFR2:** The MVP will be developed and tested as a standalone local script. Cloud deployment will be addressed post-MVP.

**NFR3:** The bot must store final audio files on the local filesystem in a designated recordings directory.

**NFR4:** Audio processing for a 60-minute recording should complete within 5 minutes.

**NFR5:** Bot commands should provide feedback within 3 seconds of execution.

**NFR6:** The bot must gracefully handle connection failures and provide clear error messages to users.

**NFR7:** Memory usage must not exceed 512MB during normal operation (single 60-minute recording).

**NFR8:** The bot must log all recording sessions, errors, and system events for debugging.

**NFR9:** The system must handle graceful shutdown, cleaning up active recordings and temporary files.

**NFR10:** Audio quality must be sufficient for voice conversations (minimum 64kbps MP3).

## 4. User Interface Design Goals

### Overall UX Vision

The user experience should be frictionless and predictable. Users should be able to start and stop recordings with zero friction and retrieve their files with a single command. The bot should feel like a reliable utility that "just works" without requiring technical knowledge.

### Key Interaction Paradigms

**Slash Commands:** All interactions initiated via Discord's native slash commands for discoverability.

**Ephemeral Messages:** All feedback messages sent as ephemeral (private) messages to avoid channel clutter.

**Clear Status Communication:** Users always know the current state (recording, processing, ready).

### Core User Flows

#### Happy Path Flow
1. User types `/join` in text channel while in voice channel
2. Bot responds: "🎙️ Recording started in [Channel Name]"
3. User continues conversation in voice channel
4. User types `/stop` when ready to end recording
5. Bot responds: "⏹️ Recording stopped. Processing audio..."
6. Bot updates: "✅ Recording complete! Use `/last_recording` to download."
7. User types `/last_recording`
8. Bot provides download link: "📁 [Recording Name] - [Duration] - [Download Link]"

#### Error Flows
- **Not in voice channel**: "❌ You must be in a voice channel to start recording."
- **Already recording**: "❌ Recording already in progress. Use `/stop` to end current session."
- **No recent recording**: "❌ No recent recording found."
- **Processing error**: "❌ Error processing recording. Please try again."

## 5. Technical Assumptions

- **Language:** JavaScript / Node.js
- **Discord Library:** discord.js with @discordjs/voice
- **Audio Processing:** FFmpeg for audio processing (installed separately)
- **File Serving:** Express.js for simple file downloads
- **Database:** None. In-memory state management only.
- **Authentication:** None for MVP. Simple file serving only.
- **Hosting:** Local machine development and testing
- **Repository:** Single repository containing all code

## 6. Operational Constraints

### Recording Limits
- **Maximum Duration:** 60 minutes per recording
- **Maximum File Size:** 200MB output limit
- **Concurrent Sessions:** 1 per guild
- **File Retention:** 24 hours automatic deletion

### Performance Requirements
- **Memory Limit:** 512MB total usage
- **Processing Time:** 5 minutes maximum for 60-minute recording
- **Response Time:** 3 seconds for command feedback
- **Disk Space:** 1GB maximum for temporary files

### Error Recovery
- **Connection Loss:** Graceful reconnection within 30 seconds
- **Processing Failure:** Clear error message and cleanup
- **System Shutdown:** Save current recording state
- **Disk Full:** Stop recording and notify user

## 7. Security Considerations

### MVP Security Model
- **File Access:** Simple URL-based access (no authentication)
- **File Isolation:** Unique filenames to prevent guessing
- **Automatic Cleanup:** Files deleted after 24 hours
- **Local Only:** No external network access required

### Future Security Enhancements (Post-MVP)
- JWT-based authentication
- User permission validation
- Rate limiting
- HTTPS support
- Audit logging

## 8. Success Metrics

### Technical Success
- [ ] Bot successfully joins voice channels
- [ ] Audio recording captures all participants
- [ ] Audio processing produces clear MP3 files
- [ ] Download links work reliably
- [ ] System handles 60-minute recordings without crashes

### User Experience Success
- [ ] Commands respond within 3 seconds
- [ ] Error messages are clear and actionable
- [ ] Recording quality is sufficient for voice conversations
- [ ] Users can successfully complete the full workflow

## 9. Next Steps

### Phase 1: MVP Implementation
1. **Risk Validation**: Prove audio capture and processing work reliably
2. **Core Features**: Implement basic recording and download workflow
3. **Testing**: Validate with real Discord voice channels
4. **Documentation**: Create setup and usage guides

### Phase 2: Enhancement (Post-MVP)
1. **Individual Stream Capture**: Implement multi-stream processing
2. **Security**: Add JWT authentication and user validation
3. **Scalability**: Multi-guild support and cloud deployment
4. **Advanced Features**: Recording management, better UX

### Architecture Requirements
The technical architecture must prioritize:
- **Simplicity**: Minimal complexity for MVP validation
- **Reliability**: Robust error handling and recovery
- **Testability**: Easy to test and debug locally
- **Extensibility**: Foundation for future enhancements

## 10. Definition of Done

### Story Completion Criteria
1. ✅ **Functionality**: All acceptance criteria implemented and tested
2. ✅ **Error Handling**: Appropriate error handling with user feedback
3. ✅ **Performance**: Meets specified time and memory limits
4. ✅ **Documentation**: Clear code comments and user instructions
5. ✅ **Integration**: Works correctly with Discord and FFmpeg
6. ✅ **Validation**: Manually tested with real voice channels

### MVP Completion Criteria
1. ✅ **End-to-End Flow**: Complete recording workflow functions
2. ✅ **Stability**: No crashes during normal operation
3. ✅ **Quality**: Audio output is clear and synchronized
4. ✅ **Usability**: Non-technical users can operate successfully
5. ✅ **Performance**: Handles 60-minute recordings reliably
