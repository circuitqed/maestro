# Build React app
FROM node:20-bookworm AS client-build

WORKDIR /app/client
COPY client/package.json ./
RUN npm install --legacy-peer-deps
COPY client/ ./
RUN npm run build

# Production server
FROM node:20-bookworm

WORKDIR /app

# Install build tools for better-sqlite3 and node-pty, plus tmux for session management
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    tmux \
    git \
    && rm -rf /var/lib/apt/lists/*

# Install server dependencies (use npm install to build native modules for this arch)
COPY server/package.json ./
RUN npm install --build-from-source

# Copy server code
COPY server/ ./

# Copy built client
COPY --from=client-build /app/client/dist ./public

# Ensure data directory exists
RUN mkdir -p /app/data

EXPOSE 5000

CMD ["node", "index.js"]
