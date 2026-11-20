#!/usr/bin/env bash
set -e

# Disable background workers on the web API process to protect HTTP request latency and prevent connection pool starvation.
if [ -n "$DYNO" ] && [ -z "$KORTIX_WORKERS_ENABLED" ]; then
  case "$DYNO" in
    web.*)
      export KORTIX_WORKERS_ENABLED="false"
      ;;
  esac
fi

GATEWAY_PORT="${LLM_GATEWAY_PROXY_PORT:-8090}"
API_PORT="${PORT:-8008}"
INTERNAL_WORKER_PORT="${INTERNAL_WORKER_PORT:-8009}"
WORKER_DB_POOL_MAX="${WORKER_DB_POOL_MAX:-3}"
# The dedicated `worker` dyno (heroku.yml → start-worker.sh) runs the jobs.
# This in-dyno fallback stays off on a Heroku `web` dyno: the web process must
# keep its CPU and DB connections for HTTP. Under pool starvation the web dyno
# has no spare for a worker's connections (2026-11-20: a 25 s DB stall took the
# API to bare H12s). A single-process deployment can still opt in by exporting
# ENABLE_IN_DYNO_WORKER=true.
ENABLE_IN_DYNO_WORKER="${ENABLE_IN_DYNO_WORKER:-false}"
if [ -n "$DYNO" ]; then
  case "$DYNO" in
    web.*) ENABLE_IN_DYNO_WORKER="false" ;;
  esac
fi
export KORTIX_DRIVE_CONFLICT_SCAN_MS="${KORTIX_DRIVE_CONFLICT_SCAN_MS:-300000}"
export KORTIX_DRIVE_INDEX_MS="${KORTIX_DRIVE_INDEX_MS:-300000}"
export KORTIX_DRIVE_INDEX_RECHECK_MS="${KORTIX_DRIVE_INDEX_RECHECK_MS:-900000}"

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

API_DIR="/app/apps/api"
if [ ! -d "$API_DIR" ]; then
  API_DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd)"
fi

cleanup() {
  echo "[shutdown] Stopping child processes..."
  if [ -n "$GATEWAY_PID" ]; then
    kill -TERM "$GATEWAY_PID" 2>/dev/null || true
  fi
  if [ -n "$WORKER_PID" ]; then
    kill -TERM "$WORKER_PID" 2>/dev/null || true
  fi
  if [ -n "$API_PID" ]; then
    kill -TERM "$API_PID" 2>/dev/null || true
  fi
}
trap cleanup SIGTERM SIGINT EXIT

# In-dyno background worker: runs as an isolated subprocess with its own event loop and small DB pool.
if [ "$ENABLE_IN_DYNO_WORKER" = "true" ]; then
  echo "[startup] Starting isolated In-Dyno Worker on :${INTERNAL_WORKER_PORT} (DB_POOL_MAX=${WORKER_DB_POOL_MAX})..."
  (
    cd "$API_DIR"
    PORT="$INTERNAL_WORKER_PORT" \
    DB_POOL_MAX="$WORKER_DB_POOL_MAX" \
    KORTIX_WORKERS_ENABLED="true" \
    KORTIX_PROCESS_ROLE="worker" \
    exec bun run src/worker.ts
  ) &
  WORKER_PID=$!
fi

echo "[startup] Starting Dosco API on port ${API_PORT}..."
cd "$API_DIR"
KORTIX_WORKERS_ENABLED="false" KORTIX_PROCESS_ROLE="web" bun run src/index.ts &
API_PID=$!

if [ -n "$GATEWAY_PID" ]; then
  wait -n "$API_PID" "$GATEWAY_PID"
else
  wait "$API_PID"
fi
EXIT_CODE=$?
echo "[shutdown] Process exited with code ${EXIT_CODE}"
exit $EXIT_CODE
