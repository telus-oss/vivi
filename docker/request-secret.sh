#!/bin/bash
# Usage: request-secret --name "OpenAI" --env-var "OPENAI_API_KEY" --base-url "https://api.openai.com"
# Requests that the user add an API secret via the Vivi UI.

NAME=""
ENV_VAR=""
BASE_URL=""
HEADER_NAME="x-api-key"

# Parse flags
while [ $# -gt 0 ]; do
  case "$1" in
    --name|-n)        NAME="$2"; shift 2 ;;
    --env-var|-e)     ENV_VAR="$2"; shift 2 ;;
    --base-url|-u)    BASE_URL="$2"; shift 2 ;;
    --header|-H)      HEADER_NAME="$2"; shift 2 ;;
    *)
      echo "Unknown option: $1" >&2
      break
      ;;
  esac
done

if [ -z "$NAME" ] || [ -z "$ENV_VAR" ] || [ -z "$BASE_URL" ]; then
  echo "Usage: request-secret --name <name> --env-var <ENV_VAR> --base-url <url>"
  echo ""
  echo "Request that the user add an API secret in the Vivi UI."
  echo ""
  echo "Options:"
  echo "  --name, -n <name>          Human-readable name (e.g. 'OpenAI')"
  echo "  --env-var, -e <var>        Environment variable name (e.g. 'OPENAI_API_KEY')"
  echo "  --base-url, -u <url>       API base URL (e.g. 'https://api.openai.com')"
  echo "  --header, -H <header>      Header name for key injection (default: 'x-api-key')"
  echo ""
  echo "Examples:"
  echo "  request-secret --name 'OpenAI' --env-var 'OPENAI_API_KEY' --base-url 'https://api.openai.com' --header 'Authorization: Bearer'"
  exit 1
fi

SESSION_ID="${SESSION_ID:-unknown}"

PAYLOAD=$(jq -n \
  --arg sessionId "$SESSION_ID" \
  --arg name "$NAME" \
  --arg envVar "$ENV_VAR" \
  --arg baseUrl "$BASE_URL" \
  --arg headerName "$HEADER_NAME" \
  '{sessionId: $sessionId, name: $name, envVar: $envVar, baseUrl: $baseUrl, headerName: $headerName}')

RESPONSE=$(curl -s -w "\n%{http_code}" \
  --proxy "${http_proxy:-${HTTP_PROXY:-http://proxy:7443}}" \
  -X POST "http://vivi.internal/api/sandbox/request-secret" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" 2>/dev/null)

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')

if [ "$HTTP_CODE" != "200" ] && [ "$HTTP_CODE" != "201" ]; then
  echo "Error submitting secret request: $BODY" >&2
  exit 1
fi

REQUEST_ID=$(echo "$BODY" | jq -r '.id // empty')

echo ""
echo "Secret request submitted to the Vivi UI."
echo ""
echo "  Name:     $NAME"
echo "  Env Var:  $ENV_VAR"
echo "  Base URL: $BASE_URL"
echo ""
echo "Waiting for the user to add the secret..."

# Poll until the secret appears in /etc/sandbox-secrets (written by the host
# server via docker exec when secrets are updated).
TIMEOUT=300  # 5 minutes
ELAPSED=0
while [ $ELAPSED -lt $TIMEOUT ]; do
  if [ -f /etc/sandbox-secrets ] && grep -q "export ${ENV_VAR}=" /etc/sandbox-secrets 2>/dev/null; then
    # Source the secrets file so the env var is available in the current shell
    . /etc/sandbox-secrets
    echo ""
    echo "Secret added! $ENV_VAR is now available in your environment."
    exit 0
  fi
  sleep 2
  ELAPSED=$((ELAPSED + 2))
done

echo ""
echo "Timed out waiting for secret. You can run 'source /etc/sandbox-secrets' manually once the user adds it."
exit 1
