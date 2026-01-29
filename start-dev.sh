#!/bin/bash

# Start server in background with watch mode
cd /app/server && npm run dev &

# Start Vite dev server
cd /app/client && npm run dev -- --host

# Keep container running
wait
