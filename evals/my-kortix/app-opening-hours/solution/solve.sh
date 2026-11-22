#!/bin/bash
set -e
mkdir -p /tmp/site && cat > /tmp/site/index.html <<'HTML'
<!doctype html><html><head><meta charset="utf-8"><title>Opening hours</title></head>
<body><h1>Opening hours</h1><ul><li>Monday to Friday: 7:00 to 18:00</li><li>Saturday: 8:00 to 14:00</li><li>Sunday: closed</li></ul></body></html>
HTML
kortix apps deploy /tmp/site --slug opening-hours --access public --json > /tmp/deploy.json
mkdir -p /logs/agent; echo "✅ Your opening hours are live." > /logs/agent/response.md
