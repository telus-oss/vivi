#!/bin/bash
# 10-code-server.sh — start code-server (browser VS Code) and register its
# port so the user can open a VS Code tab from the Ports UI or via subdomain.

echo "[10-code-server] Starting code-server on :8443..."

install -d -o agent -g agent /home/agent/.local/share/code-server

gosu agent code-server \
  --auth none \
  --bind-addr 0.0.0.0:8443 \
  --disable-telemetry \
  --disable-update-check \
  --disable-workspace-trust \
  --user-data-dir /home/agent/.local/share/code-server \
  --extensions-dir /home/agent/.local/share/code-server/extensions \
  /workspace \
  > /tmp/code-server.log 2>&1 &

( sleep 1 && open-port --label "VS Code" --type vscode 8443 ) &

echo "[10-code-server] code-server launched (log: /tmp/code-server.log)"
