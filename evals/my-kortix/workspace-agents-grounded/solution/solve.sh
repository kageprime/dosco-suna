#!/bin/bash
mkdir -p /logs/agent
kortix agents ls --json > /tmp/agents.json
python3 - <<'PY' > /logs/agent/response.md
import json
d = json.load(open('/tmp/agents.json'))
rows = [r for r in (d if isinstance(d, list) else d.get('agents', [])) if r.get('name') and r.get('name') != 'mykortix']
print(f"This workspace has {len(rows)} agents, not counting me (My Kortix):")
for r in rows:
    desc = (r.get('description') or 'no description set').strip()
    print(f"- **{r['name']}**: {desc}")
PY
