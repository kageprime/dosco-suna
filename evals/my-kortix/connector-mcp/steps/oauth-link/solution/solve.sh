#!/bin/bash
set -e
kortix connectors catalog install kortix:linear --json > /tmp/install.json
kortix connectors connect linear --owner project > /tmp/connect.txt 2>&1 || true
url=$(grep -o 'https\?://[^ ]*' /tmp/connect.txt | head -1)
mkdir -p /logs/agent; echo "🙋 Sign in to Linear here: ${url}" > /logs/agent/response.md
