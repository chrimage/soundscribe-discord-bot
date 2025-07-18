#!/usr/bin/env node

/**
 * Setup Script for SoundScribe
 * Guides users through initial configuration
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const _logger = require('../src/utils/logger');

class SetupWizard {
    constructor() {
        this.checklist = {
            node: false,
            ffmpeg: false,
            env: false,
            directories: false,
            permissions: false
        };
    }

    async run() {
        console.log('🚀 SoundScribe Setup Wizard\n');
        console.log('This script will guide you through the initial setup.\n');

        try {
            await this.checkNodeVersion();
            await this.checkFFmpeg();
            await this.setupEnvironment();
            await this.createDirectories();
            await this.checkDiscordPermissions();

            this.printSummary();

        } catch (error) {
            console.error('❌ Setup failed:', error.message);
            throw error;
        }
    }

    async checkNodeVersion() {
        console.log('📦 Checking Node.js version...');

        const nodeVersion = process.version;
        const majorVersion = parseInt(nodeVersion.slice(1).split('.')[0]);

        if (majorVersion >= 18) {
            console.log(`✅ Node.js ${nodeVersion} is supported`);
            this.checklist.node = true;
        } else {
            throw new Error(`Node.js 18+ required, found ${nodeVersion}`);
        }
    }

    async checkFFmpeg() {
        console.log('🎵 Checking FFmpeg installation...');

        try {
            const result = execSync('ffmpeg -version', { encoding: 'utf8' });
            const version = result.split('\n')[0];
            console.log(`✅ FFmpeg found: ${version}`);
            this.checklist.ffmpeg = true;
        } catch (_error) {
            console.log('❌ FFmpeg not found in PATH');
            console.log('   Please install FFmpeg:');
            console.log('   - Ubuntu/Debian: sudo apt install ffmpeg');
            console.log('   - macOS: brew install ffmpeg');
            console.log('   - Windows: Download from https://ffmpeg.org/download.html');
            console.log('   - Or set FFMPEG_PATH in .env to point to ffmpeg executable');
        }
    }

    async setupEnvironment() {
        console.log('⚙️  Setting up environment configuration...');

        const envPath = path.join(process.cwd(), '.env');
        const envExamplePath = path.join(process.cwd(), '.env.example');

        if (!fs.existsSync(envPath)) {
            if (fs.existsSync(envExamplePath)) {
                fs.copyFileSync(envExamplePath, envPath);
                console.log('✅ Created .env file from .env.example');
                console.log('   Please edit .env and add your Discord bot token');
            } else {
                console.log('❌ .env.example not found');
            }
        } else {
            console.log('✅ .env file already exists');
        }

        this.checklist.env = true;
    }

    async createDirectories() {
        console.log('📁 Creating necessary directories...');

        const directories = ['recordings', 'temp', 'logs'];

        directories.forEach(dir => {
            const dirPath = path.join(process.cwd(), dir);
            if (!fs.existsSync(dirPath)) {
                fs.mkdirSync(dirPath, { recursive: true });
                console.log(`✅ Created ${dir}/ directory`);
            } else {
                console.log(`✅ ${dir}/ directory already exists`);
            }
        });

        this.checklist.directories = true;
    }

    async checkDiscordPermissions() {
        console.log('🤖 Checking Discord bot permissions...');

        console.log('   Required permissions:');
        console.log('   - View Channels');
        console.log('   - Connect to voice channels');
        console.log('   - Speak in voice channels');
        console.log('   - Use Voice Activity');
        console.log('   - Send Messages');
        console.log('   - Embed Links');
        console.log('   - Use Slash Commands');

        console.log('   📋 Instructions:');
        console.log('   1. The bot will automatically generate an invite link when started');
        console.log('   2. Copy the invite link from the console output');
        console.log('   3. Paste it in your browser to invite the bot to your server');
        console.log('   4. All required permissions will be included automatically');

        this.checklist.permissions = true;
    }

    printSummary() {
        console.log('\n📋 Setup Summary:\n');

        Object.entries(this.checklist).forEach(([item, status]) => {
            const icon = status ? '✅' : '❌';
            console.log(`${icon} ${item.charAt(0).toUpperCase() + item.slice(1)}`);
        });

        console.log('\n🎯 Next Steps:');
        console.log('1. Edit .env file and add your Discord bot token');
        console.log('2. Install FFmpeg if not already installed');
        console.log('3. Run: npm start');
        console.log('4. Copy the invite link from the console output');
        console.log('5. Invite your bot to a test Discord server');
        console.log('6. Test with: /ping command');
    }
}

// Run setup if called directly
if (require.main === module) {
    const wizard = new SetupWizard();
    wizard.run().catch(console.error);
}

module.exports = SetupWizard;
