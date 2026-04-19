#!/bin/bash
# Thin gh wrapper — intercepts `pr create` and routes to Vivi approval flow.
# All other gh commands pass through to the real gh CLI.

REAL_GH=/usr/bin/gh-real

# Detect `gh pr create` (with or without other args before/after)
if [ "$1" = "pr" ] && [ "$2" = "create" ]; then
  # Parse flags — store all args in an array first to preserve multiline values
  shift 2  # remove "pr create"
  TITLE=""
  BODY=""
  # Detect the default branch from origin/HEAD (set by `git clone`), fallback to main
  BASE=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's|^refs/remotes/origin/||')
  [ -z "$BASE" ] && BASE="main"
  HEAD=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")

  # Store args in array to handle multiline values properly
  ARGS=("$@")
  i=0
  while [ $i -lt ${#ARGS[@]} ]; do
    case "${ARGS[$i]}" in
      --title|-t)   TITLE="${ARGS[$((i+1))]}"; i=$((i+2)) ;;
      --body|-b)    BODY="${ARGS[$((i+1))]}"; i=$((i+2)) ;;
      --base|-B)    BASE="${ARGS[$((i+1))]}"; i=$((i+2)) ;;
      --head|-H)    HEAD="${ARGS[$((i+1))]}"; i=$((i+2)) ;;
      *)            i=$((i+1)) ;;
    esac
  done

  # Default title from last commit if not provided
  if [ -z "$TITLE" ]; then
    TITLE=$(git log -1 --format="%s" 2>/dev/null || echo "Untitled PR")
  fi

  # Default body from commit messages if not provided
  if [ -z "$BODY" ]; then
    BODY=$(git log "$BASE"..HEAD --format="- %s" 2>/dev/null || echo "")
  fi

  # Build JSON payload — use jq to safely handle multiline strings and special chars
  JSON_PAYLOAD=$(jq -n \
    --arg sessionId "${SESSION_ID:-unknown}" \
    --arg title "$TITLE" \
    --arg description "$BODY" \
    --arg branch "$HEAD" \
    --arg baseBranch "$BASE" \
    '{sessionId: $sessionId, title: $title, description: $description, branch: $branch, baseBranch: $baseBranch}')

  # Submit to Vivi host server via the proxy
  RESPONSE=$(curl -s -w "\n%{http_code}" \
    --proxy "${http_proxy:-${HTTP_PROXY:-http://proxy:7443}}" \
    -X POST "http://vivi.internal/api/sandbox/pr" \
    -H "Content-Type: application/json" \
    -d "$JSON_PAYLOAD" 2>/dev/null)

  HTTP_CODE=$(echo "$RESPONSE" | tail -1)
  BODY_RESPONSE=$(echo "$RESPONSE" | sed '$d')

  if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "201" ]; then
    echo ""
    echo "PR request submitted for approval in the Vivi UI."
    echo ""
    echo "  Title:  $TITLE"
    echo "  Branch: $HEAD → $BASE"
    echo ""
    echo "The repository owner will review and choose to merge locally or create a GitHub PR."
    echo "No push required — changes are extracted directly from this sandbox."
    exit 0
  else
    echo "Error submitting PR request: $BODY_RESPONSE" >&2
    exit 1
  fi
else
  # Pass through to real gh for all other commands
  exec "$REAL_GH" "$@"
fi
