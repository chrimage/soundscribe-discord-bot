#!/usr/bin/env node

/**
 * Standalone Technical Validation Script
 * Tests core technical assumptions without requiring full configuration
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

class StandaloneValidator {
    constructor() {
        this.results = {
            node: { status: 'pending', details: [] },
            ffmpeg: { status: 'pending', details: [] },
            dependencies: { status: 'pending', details: [] },
            directories: { status: 'pending', details: [] },
            memory: { status: 'pending', details: [] }
        };
    }

    async runAllTests() {
        console.log('🔬 Starting Standalone Technical Validation...\n');

        try {
            await this.checkNodeVersion();
            await this.checkFFmpeg();
            await this.checkDependencies();
            await this.checkDirectories();
            await this.checkMemoryBaseline();
            
            this.printResults();
            this.saveResults();
            
        } catch (error) {
            console.error('❌ Validation failed:', error);
            process.exit(1);
        }
    }

    async checkNodeVersion() {
        console.log('📦 Checking Node.js version...');
        
        const nodeVersion = process.version;
        const majorVersion = parseInt(nodeVersion.slice(1).split('.')[0]);
        
        if (majorVersion >= 18) {
            console.log(`✅ Node.js ${nodeVersion} is supported`);
            this.results.node.status = 'pass';
            this.results.node.details.push(`Node.js ${nodeVersion} (>=18 required)`);
        } else {
            this.results.node.status = 'fail';
            this.results.node.details.push(`Node.js ${nodeVersion} (18+ required)`);
        }
    }

    async checkFFmpeg() {
        console.log('🎵 Checking FFmpeg installation...');
        
        try {
            const result = execSync('ffmpeg -version', { encoding: 'utf8', stdio: 'pipe' });
            const version = result.split('\n')[0];
            console.log(`✅ FFmpeg found: ${version}`);
            this.results.ffmpeg.status = 'pass';
            this.results.ffmpeg.details.push(version);
        } catch (error) {
            console.log('❌ FFmpeg not found in PATH');
            this.results.ffmpeg.status = 'fail';
            this.results.ffmpeg.details.push('FFmpeg not found - install with:');
            this.results.ffmpeg.details.push('  Ubuntu/Debian: sudo apt install ffmpeg');
            this.results.ffmpeg.details.push('  macOS: brew install ffmpeg');
            this.results.ffmpeg.details.push('  Windows: Download from https://ffmpeg.org/download.html');
        }
    }

    async checkDependencies() {
        console.log('📚 Checking dependencies...');
        
        try {
            const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));
            const nodeModulesPath = path.join(process.cwd(), 'node_modules');
            
            if (!fs.existsSync(nodeModulesPath)) {
                console.log('⚠️  node_modules not found - run: npm install');
                this.results.dependencies.status = 'warning';
                this.results.dependencies.details.push('Run: npm install');
                return;
            }

            const criticalDeps = [
                'discord.js',
                '@discordjs/voice',
                'express',
                'fluent-ffmpeg'
            ];

            const missing = [];
            criticalDeps.forEach(dep => {
                const depPath = path.join(nodeModulesPath, dep);
                if (fs.existsSync(depPath)) {
                    this.results.dependencies.details.push(`✅ ${dep}`);
                } else {
                    missing.push(dep);
                    this.results.dependencies.details.push(`❌ ${dep}`);
                }
            });

            if (missing.length === 0) {
                this.results.dependencies.status = 'pass';
            } else {
                this.results.dependencies.status = 'fail';
                this.results.dependencies.details.push(`Missing: ${missing.join(', ')}`);
            }

        } catch (error) {
            this.results.dependencies.status = 'fail';
            this.results.dependencies.details.push('Error checking dependencies');
        }
    }

    async checkDirectories() {
        console.log('📁 Checking directories...');
        
        const directories = ['recordings', 'temp', 'src', 'scripts'];
        
        directories.forEach(dir => {
            const dirPath = path.join(process.cwd(), dir);
            if (fs.existsSync(dirPath)) {
                this.results.directories.details.push(`✅ ${dir}/`);
            } else {
                this.results.directories.details.push(`❌ ${dir}/ missing`);
            }
        });

        this.results.directories.status = 'pass';
    }

    async checkMemoryBaseline() {
        console.log('🧠 Testing memory baselines...');
        
        try {
            const memUsage = process.memoryUsage();
            const memMB = {
                rss: Math.round(memUsage.rss / 1024 / 1024 * 100) / 100,
                heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024 * 100) / 100,
                heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024 * 100) / 100
            };

            this.results.memory.details.push(`Current memory usage:`);
            this.results.memory.details.push(`  RSS: ${memMB.rss}MB`);
            this.results.memory.details.push(`  Heap Total: ${memMB.heapTotal}MB`);
            this.results.memory.details.push(`  Heap Used: ${memMB.heapUsed}MB`);

            // Test memory allocation for 60-minute recording
            const sampleRate = 48000;
            const channels = 2;
            const bytesPerSample = 2;
            const durationMinutes = 60;
            const totalSamples = sampleRate * durationMinutes * 60;
            const bufferSize = totalSamples * channels * bytesPerSample;
            const bufferMB = Math.round(bufferSize / 1024 / 1024 * 100) / 100;

            this.results.memory.details.push(`60-minute recording buffer: ${bufferMB}MB`);
            
            if (bufferMB < 512) {
                this.results.memory.status = 'pass';
                this.results.memory.details.push('✅ Memory usage within 512MB limit');
            } else {
                this.results.memory.status = 'warning';
                this.results.memory.details.push('⚠️ Memory usage may exceed 512MB limit');
            }

        } catch (error) {
            this.results.memory.status = 'fail';
            this.results.memory.details.push('Error testing memory');
        }
    }

    printResults() {
        console.log('\n📊 Validation Results:\n');
        
        Object.entries(this.results).forEach(([test, result]) => {
            const statusIcon = result.status === 'pass' ? '✅' : 
                              result.status === 'warning' ? '⚠️' : '❌';
            console.log(`${statusIcon} ${test.toUpperCase()}: ${result.status}`);
            result.details.forEach(detail => console.log(`   ${detail}`));
            console.log();
        });
    }

    saveResults() {
        const resultsPath = './validation-results.json';
        const results = {
            timestamp: new Date().toISOString(),
            results: this.results,
            system: {
                nodeVersion: process.version,
                platform: process.platform,
                arch: process.arch,
                memory: process.memoryUsage()
            }
        };
        
        fs.writeFileSync(resultsPath, JSON.stringify(results, null, 2));
        console.log(`📄 Results saved to ${resultsPath}`);
    }
}

// Run validation if called directly
if (require.main === module) {
    const validator = new StandaloneValidator();
    validator.runAllTests().catch(console.error);
}

module.exports = StandaloneValidator;