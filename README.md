# SoundScribe - Discord Voice Recording Bot

A Discord bot that records voice channels and provides downloadable MP3 files. Built for reliability and simplicity.

## 🚀 Quick Start

### Prerequisites
- Node.js 18+
- FFmpeg
- Discord bot token

### Installation

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
   # Edit .env with your Discord bot token
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
   EXPRESS_PORT=3000
   ```

4. **Start the bot:**
   ```bash
   npm start
   ```
   
5. **Invite the bot:**
   - Copy the invite link from the console output
   - Paste it in your browser to add the bot to your server

## 🎯 Usage

### Commands
- `/join` - Join your voice channel and start recording
- `/stop` - Stop recording and get download link
- `/last_recording` - Get link to your most recent recording
- `/ping` - Test bot responsiveness

### Example Workflow
1. Join a voice channel
2. Type `/join` to start recording
3. Have your conversation
4. Type `/stop` to finish and get download link
5. Click the download link to save your MP3 file

## 🔧 Technical Details

### Architecture
- **Discord.js** - Discord API integration
- **@discordjs/voice** - Voice connection handling
- **FFmpeg** - Audio processing and MP3 conversion
- **Express.js** - File serving and download endpoints

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
soundscribe/
├── src/
│   ├── audio/           # Voice recording and processing
│   ├── bot/            # Discord bot commands
│   ├── server/         # Express file server
│   ├── utils/          # Utilities and helpers
│   └── config.js       # Configuration
├── scripts/            # Setup and validation
├── recordings/         # Audio files
├── temp/              # Temporary files
└── docs/              # Documentation
```

### Testing
```bash
# Validate technical assumptions
npm run validate

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

## 🛡️ Security

- Files served only from designated directory
- No directory traversal vulnerabilities
- Basic security headers implemented
- Files auto-deleted after 24 hours
- No authentication required for MVP (post-MVP enhancement)

## 📈 Monitoring

- Health check endpoint: `/health`
- Disk usage monitoring
- Memory usage tracking
- Error logging with timestamps
- Automatic cleanup logging

## 🔄 Post-MVP Features

- Individual participant recording
- JWT-based authentication
- Multi-guild support
- Advanced error recovery
- Production deployment guides
- Performance optimization
- Enhanced security features

## 🤝 Contributing

1. Fork the repository
2. Create feature branch
3. Test thoroughly with real Discord
4. Update documentation
5. Submit pull request

## 📄 License

ISC License - See LICENSE file for details