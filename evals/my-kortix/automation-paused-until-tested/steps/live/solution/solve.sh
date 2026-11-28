#!/bin/bash
id=$(kortix triggers ls --json | python3 -c "import json,sys; d=json.load(sys.stdin); print([t['id'] for t in d.get('runtime',[]) if (t.get('cron') or '').startswith('0 9')][0])")
kortix triggers run "$id"; sleep 20; kortix triggers resume "$id"
mkdir -p /logs/agent; echo "✅ Ran it once and it is live now." > /logs/agent/response.md
