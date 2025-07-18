# SoundScribe - Discord Voice Recording & Transcription Bot

A Discord bot that records voice channels, provides downloadable MP3 files, and generates AI-powered transcripts with a web interface. Built for reliability and simplicity.

## 🚀 Quick Start

### Prerequisites
- Node.js 18+ (for local development)
- Docker & Docker Compose (recommended for deployment)
- FFmpeg (included in Docker image)
- Discord bot token
- Groq API key (for AI transcription)

### Quick Start with Docker (Recommended)

1. **Clone and configure:**
   ```bash
   git clone <repository-url>
   cd soundscribe-js
   cp .env.example .env
   ```

2. **Configure environment variables in .env:**
   ```bash
   DISCORD_TOKEN=your_discord_bot_token_here
   GROQ_API_KEY=your_groq_api_key_here
   DOMAIN=yourdomain.com  # For production with HTTPS
   BASE_URL=https://yourdomain.com  # Or http://localhost:3000 for local
   WEB_PORT=3000
   ```

3. **Start with Docker:**
   ```bash
   docker-compose up -d
   ```

4. **Access the web interface:**
   - Local: `http://localhost:3000`
   - Production: `https://yourdomain.com`

### Local Development Setup

1. **Clone and install dependencies:**
   ```bash
   npm install
   ```

2. **Run setup wizard:**
   ```bash
   npm run setup
   ```

3. **Configure environment:**
   ```bash
   cp .env.example .env
   # Edit .env with your Discord bot token and Groq API key
   ```

4. **Start the bot:**
   ```bash
   npm start
   ```

### Manual Setup

1. **Install FFmpeg:**
   - Ubuntu/Debian: `sudo apt install ffmpeg`
   - macOS: `brew install ffmpeg`
   - Windows: Download from [ffmpeg.org](https://ffmpeg.org/download.html)

2. **Create Discord bot:**
   - Go to [Discord Developer Portal](https://discord.com/developers/applications)
   - Create new application → Bot
   - Enable these intents: Server Members, Message Content
   - Copy the bot token (you'll need it for the .env file)
   - The bot will automatically generate an invite link with correct permissions when started

3. **Environment variables:**
   ```bash
   DISCORD_BOT_TOKEN=your_bot_token_here
   GROQ_API_KEY=your_groq_api_key_here
   EXPRESS_PORT=3000
   BASE_URL=http://localhost:3000
   ```

4. **Get Groq API Key:**
   - Go to [Groq Console](https://console.groq.com/)
   - Create account and generate API key
   - This enables AI-powered transcription features

5. **Start the bot:**
   ```bash
   npm start
   ```
   
6. **Invite the bot:**
   - Copy the invite link from the console output
   - Paste it in your browser to add the bot to your server

## 🎯 Usage

### Commands
- `/join` - Join your voice channel and start recording
- `/stop` - Stop recording, get download link, and automatically generate transcript
- `/last_recording` - Get link to your most recent recording
- `/transcribe` - Manually generate transcript from the last recording
- `/ping` - Test bot responsiveness

### Example Workflow
1. Join a voice channel
2. Type `/join` to start recording
3. Have your conversation
4. Type `/stop` to finish recording
5. Bot provides:
   - Download link for MP3 file
   - Web interface link to view AI-generated transcript
6. Access transcript viewer for formatted, searchable transcripts with download/copy options

## 🌐 Web Interface

### Transcript Viewer Features
- **Formatted transcripts** with markdown rendering
- **Speaker identification** with timestamps
- **Confidence scores** for transcription quality
- **Download** transcripts as markdown files
- **Copy to clipboard** functionality
- **Responsive design** for mobile and desktop

### Accessing Transcripts
- Automatic links provided after `/stop` command
- Direct URL format: `https://yourdomain.com/?id=recording_id`
- Built-in React application with modern UI

### API Endpoints
- `GET /api/transcript/{id}` - Fetch transcript data
- `GET /recordings/` - List available recordings
- `GET /health` - Health check endpoint

## 🔧 Technical Details

### Architecture
- **Discord.js** - Discord API integration
- **@discordjs/voice** - Voice connection handling
- **FFmpeg** - Audio processing and MP3 conversion
- **Express.js** - File serving and API endpoints
- **React** - Web interface for transcript viewing
- **Groq API** - AI-powered speech transcription with Whisper
- **Docker + Caddy** - Production deployment with HTTPS and reverse proxy

### Performance
- **Memory usage**: < 512MB for 60-minute recordings
- **Processing time**: < 5 minutes for 60-minute recordings
- **File size**: ~30MB for 60-minute MP3 (64kbps)
- **Auto-cleanup**: Files deleted after 24 hours

### File Management
- Recordings stored in `./recordings/`
- Temporary files in `./temp/`
- Automatic cleanup every hour
- 24-hour file retention policy

## 📊 Development

### Project Structure
```
soundscribe-js/
├── src/
│   ├── audio/           # Voice recording and processing
│   ├── bot/            # Discord bot commands
│   ├── frontend/       # React web interface
│   ├── server/         # Express API server
│   ├── services/       # Transcription service (Groq API)
│   ├── utils/          # Utilities and helpers
│   └── config.js       # Configuration
├── public/             # Built frontend assets
├── scripts/            # Setup and validation
├── recordings/         # Audio files and transcripts
├── temp/               # Temporary files
├── Dockerfile          # Docker container config
├── docker-compose.yml  # Multi-container setup
└── webpack.config.js   # Frontend build config
```

### Testing
```bash
# Manual testing checklist
# 1. Bot connects to Discord
# 2. Can join voice channel
# 3. Records audio correctly
# 4. Processes to MP3
# 5. Provides download link
# 6. Files auto-cleanup
```

### Development Mode
```bash
npm run dev  # Auto-restart on file changes
```

## 🚀 Production Deployment

### Docker Production Setup
1. **Configure domain and SSL:**
   ```bash
   # Update .env for production
   DOMAIN=yourdomain.com
   BASE_URL=https://yourdomain.com
   DISCORD_BOT_TOKEN=your_production_token
   GROQ_API_KEY=your_groq_key
   ```

2. **Deploy with Docker Compose:**
   ```bash
   docker-compose up -d
   ```

3. **Features included:**
   - Automatic HTTPS with Let's Encrypt (via Caddy)
   - Reverse proxy with security headers
   - Container isolation and restart policies
   - Volume persistence for recordings

### Environment Variables
```bash
# Required
DISCORD_BOT_TOKEN=your_discord_bot_token
GROQ_API_KEY=your_groq_api_key

# Production
DOMAIN=yourdomain.com
BASE_URL=https://yourdomain.com
NODE_ENV=production

# Optional
WEB_PORT=3000
WEB_HOST=0.0.0.0
```

## 🔍 Troubleshooting

### Common Issues

**Bot won't connect:**
- Check Discord token in .env
- Verify bot has proper permissions
- Check server intents are enabled

**FFmpeg errors:**
- Ensure FFmpeg is installed and in PATH
- Set FFMPEG_PATH in .env if needed
- Check file permissions

**Transcription issues:**
- Verify Groq API key in .env
- Check Groq API quota and usage
- Ensure audio quality is sufficient

**Web interface not loading:**
- Check BASE_URL in environment variables
- Verify webpack build completed (npm run build)
- Check browser console for errors

**Memory issues:**
- Monitor with `/stats` endpoint
- Reduce recording duration
- Check available disk space

**Audio quality issues:**
- Verify voice channel bitrate
- Check network connectivity
- Test with different audio sources

### Debug Commands
- Check health: `curl http://localhost:3000/health`
- View stats: `curl http://localhost:3000/stats`
- List recordings: `curl http://localhost:3000/recordings`
- Get transcript: `curl http://localhost:3000/api/transcript/{recording_id}`
- Test web interface: Open `http://localhost:3000/?id={recording_id}`

## 🛡️ Security

- Files served only from designated directory
- No directory traversal vulnerabilities
- Comprehensive security headers via Caddy reverse proxy:
  - Strict-Transport-Security (HSTS)
  - X-Content-Type-Options
  - X-Frame-Options
  - X-XSS-Protection
  - Referrer-Policy
- Files auto-deleted after 24 hours
- Container isolation in production
- Automatic HTTPS with Let's Encrypt
- No authentication required for MVP (post-MVP enhancement)

## 📈 Monitoring

- Health check endpoint: `/health`
- Disk usage monitoring
- Memory usage tracking
- Error logging with timestamps
- Automatic cleanup logging

## 🔄 Implemented Features

- ✅ AI-powered transcription with Groq API
- ✅ React web interface for transcript viewing
- ✅ Docker deployment with HTTPS
- ✅ Automatic speech recognition with confidence scoring
- ✅ Speaker identification and timestamp tracking

## 🔄 Planned Enhancements

- Transcript summarization
- Transcript search and indexing
- Improved transcription and recording storage system

## 🤝 Contributing

1. Fork the repository
2. Create feature branch
3. Test thoroughly with real Discord
4. Update documentation
5. Submit pull request

## 📄 License

ISC License - See LICENSE file for details
