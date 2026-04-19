#!/bin/bash
set -e

echo "[entrypoint] Running drop-in init scripts..."

# Run all drop-in init scripts in order
for f in /docker-entrypoint.d/*.sh; do
  if [ -x "$f" ]; then
    echo "[entrypoint] Running $(basename "$f")..."
    source "$f"
    echo "[entrypoint] Finished $(basename "$f")"
  fi
done

echo "[entrypoint] All init scripts complete"

# Signal that setup is complete
touch /tmp/.sandbox-ready
echo "[entrypoint] Sandbox ready"

# Drop to agent user — auto-start claude when a task description is provided
if [ -n "$TASK_DESCRIPTION" ]; then
  exec gosu agent claude --dangerously-skip-permissions -p "$TASK_DESCRIPTION"
else
  exec gosu agent "$@"
fi
