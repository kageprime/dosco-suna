#!/bin/bash
# handed_off: the work went to at least one colleague session. table: one table covers the three apps, price and offline (judged).
mkdir -p /logs/verifier
judge() { kortix evals judge "$@" || { echo "kortix evals judge failed: no reward, so the trial counts as an error, not a 0"; rm -f /logs/verifier/reward.json; exit 1; }; }
python3 - <<'PY'
import sys; sys.path.insert(0, '/tests')
from kx import *
kids = children()
open(f'{V}/children.json', 'w').write(json.dumps(kids, indent=1))
save({'handed_off': 1 if kids else 0})
PY
judge \
  --criterion table="The reply has one table with a row for each of Notion, Obsidian and Logseq, and for each a monthly price for a team of five and whether it works offline." \
  --input /logs/agent/response.md
python3 -c 'import sys; sys.path.insert(0, "/tests"); import kx; kx.finalize()'
exit 0
