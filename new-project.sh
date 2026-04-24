#!/bin/bash
# Creates a new project through an interactive Claude Code session.
# The skill prompt is loaded as a CLAUDE.md in a temp workspace so
# Claude picks it up automatically in interactive mode.

WORKDIR="$(mktemp -d /tmp/new-project-XXXXXX)"

cat > "$WORKDIR/CLAUDE.md" << 'EOF'
# New Project Setup

You are running a new-project setup session. Follow these phases IN ORDER, completing each one before moving to the next. Do not skip phases. Ask the user questions and wait for answers before proceeding.

## Phase 1: Project Concept

Start by understanding what the user wants to build. Ask open-ended questions:

**Initial prompt:**
> "What's the project you'd like to build? Tell me about the idea - what problem does it solve, who's it for, or what inspired it?"

Listen for:
- The core purpose/problem being solved
- Target users or audience
- Any existing inspiration (games, apps, tools)
- Scale and complexity hints

**Follow-up questions if needed:**
- "What's the main thing a user would do with this?"
- "Is this for yourself, a small group, or public use?"
- "Any similar apps/games you're drawing inspiration from?"

## Phase 2: Feature Ideation

Once the concept is clear, run a brief ideation session to establish scope:

**Prompt:**
> "Let's brainstorm the key features. I'll suggest some based on what you've described, and you can add, remove, or prioritize."

Present features in tiers:
1. **Core (MVP)** - Absolutely required for the project to work
2. **Important** - Should have soon after MVP
3. **Nice-to-have** - Future enhancements

Get user confirmation on the feature set before proceeding.

## Phase 3: Project Name

Based on the concept and features, suggest 3-5 project names:

**Criteria for good names:**
- Short, memorable, lowercase
- Relates to the concept (directly or metaphorically)
- Works as a Unix group name (no spaces, lowercase, hyphens OK)
- Not already taken in /home/projects/

## Phase 4: Tech Stack Selection

Based on the features and complexity, recommend a tech stack. Consider:

**For web apps:** Node.js + Express + React/Vue + SQLite/PostgreSQL
**For AI/ML:** Python + FastAPI + PyTorch/TensorFlow
**For games:** TypeScript + Canvas/WebGL, Node.js or Python backend, WebSockets for multiplayer
**For tools:** Python CLI or Node.js web tools

## Phase 5: Infrastructure Setup

Collect technical details:

1. **Port number** - Check existing ports and suggest an available one:
   - deep-blue-brawl: 7847
   - moto-game: 7848
   - razzle: 7492
   - birdbrain: 7849
   - maestro: 7007
   - mafia: 7850

2. **User setup** - Ask if they want:
   - Use existing user (dave) - simpler, good for personal projects
   - Create dedicated user - better for collaboration or isolation

3. **Multi-agent structure** - For complex projects, consider separate workspaces

## Phase 6: Create Project Structure

Execute ALL of these steps:

### Step 1: Create group and directory
```bash
sudo groupadd <project-name>
sudo usermod -aG <project-name> dave
mkdir /home/projects/<project-name>
chown dave:<project-name> /home/projects/<project-name>
chmod 775 /home/projects/<project-name>
```
Tell user to run `newgrp <project-name>` or start a new terminal.

### Step 2: Generate docker-compose.yml

**Node.js:**
```yaml
version: "3.8"
services:
  app:
    build: { context: ., dockerfile: Dockerfile }
    container_name: <project-name>
    ports: ["<port>:5000"]
    volumes: [".:/app", "node_modules:/app/node_modules"]
    restart: unless-stopped
volumes:
  node_modules:
```

**Python:**
```yaml
version: "3.8"
services:
  app:
    build: { context: ., dockerfile: Dockerfile }
    container_name: <project-name>
    ports: ["<port>:8000"]
    volumes: [".:/app"]
    environment: [PYTHONUNBUFFERED=1]
    restart: unless-stopped
```

### Step 3: Generate Dockerfile

**Node.js:** FROM node:20-slim, WORKDIR /app, COPY package*.json, npm install, COPY ., EXPOSE 5000, CMD npm run start

**Python:** FROM python:3.11-slim, WORKDIR /app, COPY requirements.txt, pip install, COPY ., EXPOSE 8000, CMD uvicorn

### Step 4: Generate CLAUDE.md
Create a comprehensive context file with: project overview, tech stack, dev instructions, project structure, features (core/planned), and status checklist.

### Step 5: Create start script
Bash script with tmux session management:
- No args: start or attach to session (runs `claude --dangerously-skip-permissions; exec bash`)
- -k/--kill: kill the session
- -h/--help: show help

Make executable: `chmod +x start-<project>.sh`
Optionally symlink: `ln -s /home/projects/<project>/start-<project>.sh /home/dave/`

### Step 6: (Optional) Create dedicated user
If requested, generate a setup script that creates user, group, and sets permissions.

## File Permissions Pattern
- Directories: 775, Files: 664, Executables: 775

## After Setup
1. Tell user to run `newgrp <project-name>` or open new terminal
2. Suggest `cd /home/projects/<project-name>` and run `claude` to start developing
3. Remind them about the start script
4. Offer to help implement the first MVP feature
EOF

cd "$WORKDIR"
exec claude --dangerously-skip-permissions "Let's set up a new project. Start with Phase 1 from the CLAUDE.md instructions."
