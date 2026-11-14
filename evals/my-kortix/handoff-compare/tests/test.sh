#!/bin/bash
# handed_off: the research went to 1 to 3 colleague sessions (My Kortix hands off real work; more than 3 for three units is a fan-out).
# covers_all: the final reply names all three tools. compares + plain: judged on the final reply, written after the colleague reported.
mkdir -p /logs/verifier
kortix sessions ls --children "$KORTIX_SESSION_ID" --json > /logs/verifier/children.json 2>/logs/verifier/children.err
python3 - <<'PY'
import json, re, os
rows = []
try:
    d = json.load(open('/logs/verifier/children.json'))
    rows = d if isinstance(d, list) else (d.get('sessions') or d.get('items') or [])
except Exception as e:
    print('no children:', e)
reply = open('/logs/agent/response.md').read() if os.path.exists('/logs/agent/response.md') else ''
r = {'handed_off': 1 if 1 <= len(rows) <= 3 else 0, 'covers_all': 1 if all(re.search(n, reply, re.I) for n in ('linear', 'asana', 'clickup')) else 0}
print(len(rows), 'children', r)
json.dump(r, open('/logs/verifier/reward.json', 'w'))
PY
kortix evals judge \
  --criterion compares="The reply compares the paid plans of Linear, Asana and ClickUp: for each, its paid tiers and what sets it apart, in a short summary." \
  --criterion plain="The reply uses no technical words such as subagent, session id, sandbox or task_id." \
  --input /logs/agent/response.md || { echo "kortix evals judge failed: no reward, so the trial counts as an error, not a 0"; rm -f /logs/verifier/reward.json; exit 1; }
