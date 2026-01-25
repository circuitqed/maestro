FROM node:20-slim

WORKDIR /app

# Install build tools for better-sqlite3 and node-pty, plus screen for session management
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    screen \
    git \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 5000

CMD ["npm", "run", "start"]
