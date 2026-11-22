#!/bin/bash
# created + one_agent: a new workspace agent for the newsletter exists, and only one. job + no_invention: its instructions (judged).
mkdir -p /logs/verifier
judge() { kortix evals judge "$@" || { echo "kortix evals judge failed: no reward, so the trial counts as an error, not a 0"; rm -f /logs/verifier/reward.json; exit 1; }; }
python3 - <<'PY'
import sys; sys.path.insert(0, '/tests')
from kx import *
agents = [a for a in rows(kj('agents ls'), 'agents') if not a.get('builtin') and a.get('name') != 'worker']
match = [a for a in agents if re.search(r'newsletter', f"{a.get('name', '')} {a.get('description') or ''}", re.I)]
block = ((kj(f"agents config {match[0]['name']}") or {}).get('block') or {}) if match else {}
open(f'{V}/agent.json', 'w').write(json.dumps(block, indent=1))
save({'created': 1 if match else 0, 'one_agent': 1 if len(agents) == 1 else 0})
PY
judge \
  --criterion job="The agent's instructions make it write a short, friendly monthly customer newsletter from the notes it is given." \
  --criterion no_invention="The instructions tell it never to invent numbers or facts that are not in the notes." \
  --input /logs/verifier/agent.json
python3 -c 'import sys; sys.path.insert(0, "/tests"); import kx; kx.finalize()'
exit 0
