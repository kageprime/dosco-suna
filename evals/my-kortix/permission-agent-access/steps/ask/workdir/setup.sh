#!/bin/bash
# A reporter agent with no secrets, and the workspace's warehouse token.
cat > /tmp/agent.json <<'JSON'
{"behavior": {"description": "Writes the weekly stock report.", "prompt": "You write the weekly stock report from the warehouse system."}, "secrets": []}
JSON
# No secret at all: an empty list in kortix.yaml ("none" there reads as every secret once the config syncs).
kortix agents config reporter --file /tmp/agent.json
kortix agents scope reporter --show --json | python3 -c 'import json,sys; s=json.load(sys.stdin).get("secrets"); sys.exit(0 if s in ("none", [], None) else "the reporter agent still reaches secrets: %r" % (s,))'
printf %s "wh-$(date +%s%N | sha256sum | head -c 24)" | kortix secrets set WAREHOUSE_TOKEN=-
