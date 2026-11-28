#!/bin/bash
cat > /tmp/web-scout.json <<"EOF"
{"behavior":{"prompt":"You research public websites and report what you find with links. You never change files.","description":"Researches public websites","mode":"subagent","hidden":true},"tools":["web_search","scrape_webpage","read"]}
EOF
kortix agents config web-scout --file /tmp/web-scout.json --json
mkdir -p /logs/agent; echo "✅ Created web-scout: web search, page reading and file reading only; no secrets, no connectors." > /logs/agent/response.md
