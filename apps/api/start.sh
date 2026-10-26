#!/usr/bin/env bash
set -e

GATEWAY_PORT="${LLM_GATEWAY_PROXY_PORT:-8090}"
API_PORT="${PORT:-8008}"

if [ -z "$GATEWAY_INTERNAL_TOKEN" ]; then
  export GATEWAY_INTERNAL_TOKEN="$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')"
fi
export GATEWAY_API_TOKEN="$GATEWAY_INTERNAL_TOKEN"
export LLM_GATEWAY_PROXY_PORT="$GATEWAY_PORT"

GATEWAY_DIR="/app/apps/llm-gateway"
if [ ! -d "$GATEWAY_DIR" ]; then
  GATEWAY_DIR="$(cd "$(dirname "$0")/../llm-gateway" 2>/dev/null && pwd || true)"
fi

if [ -d "$GATEWAY_DIR" ]; then
  echo "[startup] Starting Dosco LLM Gateway on :${GATEWAY_PORT} (API at http://127.0.0.1:${API_PORT})..."
  (
    cd "$GATEWAY_DIR"
    PORT="$GATEWAY_PORT" \
    KORTIX_API_URL="http://127.0.0.1:${API_PORT}" \
    GATEWAY_INTERNAL_TOKEN="$GATEWAY_INTERNAL_TOKEN" \
    GATEWAY_API_TOKEN="$GATEWAY_INTERNAL_TOKEN" \
    exec bun run src/main.ts
  ) &
  GATEWAY_PID=$!
else
  echo "[startup] Warning: LLM gateway directory not found, gateway not started locally"
fi

cleanup() {
  echo "[shutdown] Stopping child processes..."
  if [ -n "$GATEWAY_PID" ]; then
    kill -TERM "$GATEWAY_PID" 2>/dev/null || true
  fi
  if [ -n "$API_PID" ]; then
    kill -TERM "$API_PID" 2>/dev/null || true
  fi
}
trap cleanup SIGTERM SIGINT EXIT

API_DIR="/app/apps/api"
if [ ! -d "$API_DIR" ]; then
  API_DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd)"
fi

echo "[startup] Starting Dosco API on port ${API_PORT}..."
cd "$API_DIR"
bun run src/index.ts &
API_PID=$!

if [ -n "$GATEWAY_PID" ]; then
  wait -n "$API_PID" "$GATEWAY_PID"
else
  wait "$API_PID"
fi
EXIT_CODE=$?
echo "[shutdown] Process exited with code ${EXIT_CODE}"
exit $EXIT_CODE
