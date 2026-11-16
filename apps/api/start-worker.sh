#!/usr/bin/env bash
set -e

API_DIR="/app/apps/api"
if [ ! -d "$API_DIR" ]; then
  API_DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd)"
fi

echo "[startup] Starting Dosco Background Worker..."
cd "$API_DIR"
export KORTIX_WORKERS_ENABLED="true"
# Keep background workers from sharing web's higher DB_POOL_MAX on Supavisor.
export DB_POOL_MAX="${WORKER_DB_POOL_MAX:-5}"
exec bun run src/worker.ts
