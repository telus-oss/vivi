#!/bin/bash
# Usage: open-git
# Starts a git daemon serving /workspace and exposes it via open-port.
# Idempotent — if git daemon is already running, just prints the remote URL.

set -e

GIT_PORT=9418

# Check if git daemon is already running
if pgrep -f "git daemon.*--port=$GIT_PORT" >/dev/null 2>&1; then
  echo ""
  echo "Git server is already running on port $GIT_PORT."
  echo ""
  # Re-expose the port to display the current host mapping
  open-port --label "Git Server" --type git $GIT_PORT
  echo ""
  echo "Add this remote from your local machine using the host port shown above:"
  echo "  git remote add sandbox git://${HOST:-localhost}:<HOST_PORT>/"
  echo ""
  exit 0
fi

# Ensure /workspace is a git repository
if [ ! -d /workspace/.git ]; then
  echo "Error: /workspace is not a git repository" >&2
  exit 1
fi

# Start git daemon in the background
git daemon \
  --reuseaddr \
  --base-path=/workspace \
  --export-all \
  --enable=receive-pack \
  --listen=0.0.0.0 \
  --port=$GIT_PORT \
  /workspace &

# Give it a moment to start
sleep 0.5

# Verify it started
if ! pgrep -f "git daemon.*--port=$GIT_PORT" >/dev/null 2>&1; then
  echo "Error: git daemon failed to start" >&2
  exit 1
fi

echo "[sandbox] Git daemon started on port $GIT_PORT"

# Expose via open-port
open-port --label "Git Server" --type git $GIT_PORT
