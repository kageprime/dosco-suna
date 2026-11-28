#!/bin/bash
kortix connectors catalog install kortix:gmail --json > /tmp/install.json || true
kortix connectors connect gmail --owner me > /tmp/connect.txt 2>&1 || true
url=$(grep -o 'https\?://[^ ]*' /tmp/connect.txt | head -1)
mkdir -p /logs/agent; echo "🙋 Sign in to Gmail here: ${url}" > /logs/agent/response.md
