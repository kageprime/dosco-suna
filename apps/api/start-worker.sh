#!/usr/bin/env bash
set -e

API_DIR="/app/apps/api"
if [ ! -d "$API_DIR" ]; then
  API_DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd)"
fi

echo "[startup] Starting Dosco Background Worker..."
cd "$API_DIR"
export KORTIX_WORKERS_ENABLED="true"
exec bun run src/worker.ts
