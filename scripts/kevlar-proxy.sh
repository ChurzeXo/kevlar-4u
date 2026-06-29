#!/bin/bash
# kevlar-proxy.sh — stdio sniffer for MCP traffic
# Point WorkBuddy's kevlar-4u-local command to this script.
# Log: /tmp/kevlar-stdio-<timestamp>.jsonl
#
# Usage: ./kevlar-proxy.sh [kevlar-binary] [args...]
#   Default binary: node /path/to/kevlar/dist/scripts/cli.js

set -euo pipefail

LOG="${KEVLAR_SNIFF_LOG:-/tmp/kevlar-stdio-$(date +%Y%m%d_%H%M%S).jsonl}"
REAL_CMD=("${@:-node /Users/churze/Documents/MCP-Service/kevlar/dist/scripts/cli.js}")

echo "[proxy] PID=$$ LOG=$LOG" >&2
echo "[proxy] cmd: ${REAL_CMD[*]}" >&2

# Create named pipes for bidirectional interception
PIPE_TO_CHILD=$(mktemp -u /tmp/kevlar-pipe-in-XXXXXX)
PIPE_FROM_CHILD=$(mktemp -u /tmp/kevlar-pipe-out-XXXXXX)
mkfifo "$PIPE_TO_CHILD" "$PIPE_FROM_CHILD"
trap "rm -f $PIPE_TO_CHILD $PIPE_FROM_CHILD" EXIT

# Start real kevlar-4u, connected to pipes
"${REAL_CMD[@]}" < "$PIPE_TO_CHILD" > "$PIPE_FROM_CHILD" 2>/tmp/kevlar-stderr.log &
CHILD_PID=$!
echo "[proxy] child PID=$CHILD_PID" >&2

# Tee stdin -> log + child pipe (IN direction)
# Tee child pipe -> log + stdout (OUT direction)
# We run both in background
(
  while IFS= read -r line; do
    echo "[IN]  $line" >> "$LOG"
    echo "$line"
  done
) < /dev/stdin > "$PIPE_TO_CHILD" &

(
  while IFS= read -r line; do
    echo "[OUT] $line" >> "$LOG"
    echo "$line"
  done
) < "$PIPE_FROM_CHILD" > /dev/stdout &

# Wait for child to exit
wait $CHILD_PID
EXIT_CODE=$?
echo "[proxy] child exited code=$EXIT_CODE" >&2
exit $EXIT_CODE
