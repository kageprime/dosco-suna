#!/bin/bash
# covers_all: every agent of `kortix agents ls` (except My Kortix itself) is in the reply. grounded + counts: judged against the list.
mkdir -p /logs/verifier
kortix agents ls --json > /logs/verifier/agents.json 2>/logs/verifier/agents.err
python3 - <<'PY'
import json, os
names = []
try:
    d = json.load(open('/logs/verifier/agents.json'))
    rows = d if isinstance(d, list) else (d.get('agents') or [])
    names = [r.get('name') for r in rows if r.get('name') and r.get('name') != 'mykortix']
except Exception as e:
    print('no agents:', e)
reply = (open('/logs/agent/response.md').read() if os.path.exists('/logs/agent/response.md') else '').lower()
r = {'covers_all': 1 if names and all(n.lower() in reply for n in names) else 0}
print(names, r)
json.dump(r, open('/logs/verifier/reward.json', 'w'))
PY
kortix evals judge \
  --criterion grounded="Every agent the reply names is in the agent list, and what the reply says each one is for agrees with that agent's description in the list. The reply invents no agent." \
  --criterion counts="The reply gives the number of agents, and it matches the list (counting My Kortix or not, as long as the reply says which)." \
  --input /logs/agent/response.md --input /logs/verifier/agents.json || { echo "kortix evals judge failed: no reward, so the trial counts as an error, not a 0"; rm -f /logs/verifier/reward.json; exit 1; }
