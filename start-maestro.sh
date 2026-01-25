#!/bin/bash

SESSION_NAME="maestro"
PROJECT_DIR="/home/projects/maestro"

show_help() {
    echo "Usage: $0 [option]"
    echo ""
    echo "Options:"
    echo "  (no args)   Start or attach to the session"
    echo "  -k, --kill  Kill the session"
    echo "  -h, --help  Show this help message"
}

kill_session() {
    if screen -list | grep -q "$SESSION_NAME"; then
        screen -S "$SESSION_NAME" -X quit
        echo "Session '$SESSION_NAME' killed."
    else
        echo "No session '$SESSION_NAME' found."
    fi
}

start_or_attach() {
    if screen -list | grep -q "$SESSION_NAME"; then
        echo "Attaching to existing session '$SESSION_NAME'..."
        screen -r "$SESSION_NAME"
    else
        echo "Starting new session '$SESSION_NAME'..."
        screen -S "$SESSION_NAME" -c /dev/null bash -c "cd '$PROJECT_DIR' && claude --dangerously-skip-permissions; exec bash"
    fi
}

case "$1" in
    -k|--kill) kill_session ;;
    -h|--help) show_help ;;
    "") start_or_attach ;;
    *) echo "Unknown option: $1"; show_help; exit 1 ;;
esac
