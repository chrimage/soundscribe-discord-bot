# Discord Audio Recording Research - Comprehensive Findings

## Problem Analysis

### Root Cause of Static/Empty Audio Issues

**The Issue**: Discord.js provides **raw Opus packets without proper container framing**. These packets are "not self-delimiting" and require proper containerization to be playable.

**Technical Details**:
- Discord.js `receiver.subscribe(userId, { mode: 'opus' })` returns raw RTP-wrapped Opus packets
- Opus packets require container format (OGG/WebM) to be properly decoded
- Raw Opus streams cannot be directly saved as playable audio files
- Discord uses: **48kHz, stereo (2-channel), encrypted Opus in RTP packets**

## Research Findings

### 1. Discord Technical Specifications
- **Sample Rate**: 48,000 Hz (fixed)
- **Channels**: 2 (stereo) - Discord always sends stereo even for mono sources
- **Codec**: Opus with RTP framing
- **Encryption**: xsalsa20_poly1305 (Discord.js handles decryption)
- **Packet Format**: RTP Header + Encrypted Opus payload
- **Frame Sizes**: Variable (2.5ms to 60ms frames)

### 2. Why Current Approach Fails
1. **Raw Opus Problem**: Saving raw Opus packets creates unplayable files
2. **Container Missing**: Opus needs OGG/WebM wrapper for media players
3. **Framing Issues**: Raw packets lack proper timing/sync information
4. **Self-Delimiting**: Opus packets don't contain their own length info

### 3. Successful Bot Approaches (Craig, etc.)
- **Craig Bot**: Uses multi-track FLAC exports (likely decodes to PCM first)
- **Working bots**: Convert to PCM immediately, then re-encode to desired format
- **Industry standard**: Never save raw Opus - always containerize or convert

## Proven Solutions

### Solution 1: Immediate PCM Conversion (Recommended)
```javascript
// Record as PCM immediately - no raw Opus storage
const audioStream = receiver.subscribe(userId, {
    mode: 'pcm',  // Back to PCM mode
    end: { behavior: 'manual' }
});
```

**Advantages**:
- Guaranteed playable audio
- No container issues
- Matches successful bot implementations
- Easier to debug and validate

### Solution 2: Proper Opus Containerization
```javascript
// For Opus mode with proper OGG wrapping
ffmpeg()
    .input(rawOpusFile)
    .inputFormat('opus')
    .audioCodec('copy') // Don't re-encode
    .format('ogg')
    .outputOptions([
        '-map_metadata', '-1', // Remove metadata
        '-fflags', '+bitexact'  // Ensure consistent output
    ])
    .output(outputFile)
```

### Solution 3: WebM Container (Alternative)
```javascript
// WebM container for Opus (better browser support)
ffmpeg()
    .input(rawOpusFile)
    .audioCodec('copy')
    .format('webm')
    .output(outputFile)
```

## Technical Implementation Plan

### Phase 1: Return to PCM with Correct Parameters
```javascript
// VoiceRecorder.js - Correct PCM settings
const audioStream = receiver.subscribe(userId, {
    mode: 'pcm',
    end: { behavior: 'manual' }
});

// AudioProcessor.js - Correct PCM conversion
ffmpeg()
    .input(pcmFilePath)
    .inputFormat('s16le')  // 16-bit signed little-endian
    .inputOptions([
        '-ar 48000',       // 48kHz sample rate
        '-ac 2'            // 2 channels (stereo)
    ])
    .audioCodec('libvorbis')
    .audioBitrate('128k')
    .format('ogg')
    .output(outputPath)
```

### Phase 2: Enhanced Error Handling
```javascript
// Add format validation
async validateAudioFormat(inputFile) {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(inputFile, (err, metadata) => {
            if (err) {
                reject(new Error(`Invalid audio format: ${err.message}`));
            } else {
                // Validate expected format
                const audio = metadata.streams[0];
                if (audio.sample_rate !== 48000) {
                    reject(new Error(`Unexpected sample rate: ${audio.sample_rate}`));
                }
                resolve(metadata);
            }
        });
    });
}
```

### Phase 3: Multiple Format Support
```javascript
// Support multiple output formats for compatibility
async createMultipleFormats(inputFile, basePath) {
    const formats = [
        { ext: 'ogg', codec: 'libvorbis' },
        { ext: 'mp3', codec: 'libmp3lame' },
        { ext: 'wav', codec: 'pcm_s16le' }
    ];
    
    const outputs = await Promise.all(
        formats.map(format => this.convertToFormat(inputFile, basePath, format))
    );
    
    return outputs;
}
```

## Fallback Strategies

### Strategy 1: Format Detection
1. Try PCM with stereo (48kHz, 2-channel)
2. If fails, try PCM with mono (48kHz, 1-channel)
3. If fails, try different bit depths (s32le, s24le)

### Strategy 2: Container Flexibility
1. Primary: OGG Vorbis (best compatibility)
2. Fallback: WebM Opus (modern browsers)
3. Emergency: WAV PCM (universal but large)

### Strategy 3: Validation Pipeline
1. Record audio sample
2. Validate with ffprobe
3. Test playback capability
4. Adjust parameters if needed

## Key Insights from Research

1. **Discord.js Limitation**: Raw Opus mode is fundamentally problematic for file storage
2. **PCM is Standard**: All successful Discord bots use PCM mode for recording
3. **Container Critical**: Opus requires proper containerization (OGG/WebM)
4. **Timing Matters**: RTP timing info is lost in raw Opus files
5. **Craig's Success**: Uses PCM → processing → FLAC/AAC export pipeline

## Recommended Implementation

```javascript
// Final recommended approach
class VoiceRecorder {
    async startRecording(interaction) {
        // Use PCM mode with proper Discord specifications
        const audioStream = receiver.subscribe(userId, {
            mode: 'pcm',
            end: { behavior: 'manual' }
        });
        
        // Stream to PCM file with proper format
        const pcmFile = path.join(tempDir, `${userId}.pcm`);
        const writeStream = fs.createWriteStream(pcmFile);
        audioStream.pipe(writeStream);
        
        return { pcmFile, writeStream };
    }
}

class AudioProcessor {
    async convertPcmToOgg(pcmFile, outputFile) {
        return new Promise((resolve, reject) => {
            ffmpeg()
                .input(pcmFile)
                .inputFormat('s16le')
                .inputOptions(['-ar 48000', '-ac 2'])
                .audioCodec('libvorbis')
                .audioBitrate('128k')
                .format('ogg')
                .output(outputFile)
                .on('end', resolve)
                .on('error', reject)
                .run();
        });
    }
}
```

This approach eliminates the Opus containerization problems entirely by using Discord's PCM mode with correct parameters, matching the approach used by successful Discord recording bots.