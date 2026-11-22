#!/bin/bash
set -e
url=$(kortix secrets request ACME_API_KEY 2>&1 | grep -o 'https\?://[^ ]*' | head -1)
mkdir -p /logs/agent; echo "🙋 Save the Acme API key here, and nobody sees it in chat: ${url}" > /logs/agent/response.md
