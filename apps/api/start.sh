#!/bin/sh
set -e
cd /app/apps/api
echo "[startup] Starting Dosco API on port ${PORT:-8008}..."
exec bun run src/serve.ts

