#!/bin/bash
# Usage: open-port [--container <name>] <port>
# Requests port forwarding from the Vivi host server.
# With --container, forwards a port from a Docker container launched in the sandbox.

CONTAINER_NAME=""
LABEL=""
PORT_TYPE=""

# Parse flags
while [ $# -gt 0 ]; do
  case "$1" in
    --container|-c)
      CONTAINER_NAME="$2"
      shift 2
      ;;
    --label|--name|-n)
      LABEL="$2"
      shift 2
      ;;
    --type|-t)
      PORT_TYPE="$2"
      shift 2
      ;;
    *)
      break
      ;;
  esac
done

PORT=$1
if [ -z "$PORT" ]; then
  echo "Usage: open-port [options] <port>"
  echo ""
  echo "Options:"
  echo "  --label, --name, -n <name>       Human-readable label (e.g. 'Frontend Dev Server')"
  echo "  --container, -c <container>      Forward from a Docker container instead of localhost"
  echo ""
  echo "Examples:"
  echo "  open-port 3000                                      # Forward sandbox port 3000"
  echo "  open-port --label 'API Server' 8080                 # Forward with a label"
  echo "  open-port --container myapp --label 'My App' 3000   # Forward from Docker container"
  exit 1
fi

# Validate port is a number
if ! [[ "$PORT" =~ ^[0-9]+$ ]]; then
  echo "Error: port must be a number" >&2
  exit 1
fi

SESSION_ID="${SESSION_ID:-unknown}"

# If --container is specified, resolve the container's IP address so the
# host-side socat can reach it through the sandbox.
TARGET_HOST=""
if [ -n "$CONTAINER_NAME" ]; then
  # Resolve the DinD container's IP on the bridge network
  RUNTIME="${CONTAINER_RUNTIME:-docker}"
  TARGET_HOST=$($RUNTIME inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$CONTAINER_NAME" 2>/dev/null)
  if [ -z "$TARGET_HOST" ]; then
    echo "Error: could not resolve IP for container '$CONTAINER_NAME'" >&2
    echo "Make sure the container exists: docker ps" >&2
    exit 1
  fi
fi

# Build JSON payload using jq for safe string escaping
PAYLOAD=$(jq -n \
  --argjson port "$PORT" \
  --arg sessionId "$SESSION_ID" \
  --arg targetHost "${TARGET_HOST:-}" \
  --arg containerName "${CONTAINER_NAME:-}" \
  --arg portLabel "${LABEL:-}" \
  --arg portType "${PORT_TYPE:-}" \
  '{port: $port, sessionId: $sessionId}
   + (if $targetHost != "" then {targetHost: $targetHost} else {} end)
   + (if $containerName != "" then {containerName: $containerName} else {} end)
   + (if $portLabel != "" then {label: $portLabel} else {} end)
   + (if $portType != "" then {type: $portType} else {} end)'
)

RESPONSE=$(curl -s -w "\n%{http_code}" \
  --proxy "${http_proxy:-${HTTP_PROXY:-http://proxy:7443}}" \
  -X POST "http://vivi.internal/api/sandbox/ports" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" 2>/dev/null)

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')

if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "201" ]; then
  HOST_PORT=$(echo "$BODY" | jq -r '.hostPort // empty')
  PROXY_URL=$(echo "$BODY" | jq -r '.proxyUrl // empty')
  DISPLAY_URL="${PROXY_URL:-http://localhost:${HOST_PORT}}"
  echo ""
  echo "Port forwarded successfully!"
  if [ -n "$CONTAINER_NAME" ]; then
    echo "  Container $CONTAINER_NAME:$PORT → ${DISPLAY_URL}"
  else
    echo "  Container port $PORT → ${DISPLAY_URL}"
  fi
  echo ""
  echo "The user can access this in their browser."
  exit 0
else
  echo "Error: $BODY" >&2
  exit 1
fi
