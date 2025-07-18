FROM node:lts-alpine

# Update npm to latest version and install FFmpeg
RUN npm install -g npm@latest && \
    apk add --no-cache ffmpeg

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install all dependencies (needed for webpack build)
RUN npm ci

# Copy source code
COPY src/ ./src/
COPY webpack.config.js ./

# Build frontend
RUN npm run build

# Remove dev dependencies to reduce image size
RUN npm prune --production

# Expose port
EXPOSE 3000

# Start the application
CMD ["npm", "start"]