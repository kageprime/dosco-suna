#!/bin/bash
# deleted: the file is gone.
mkdir -p /logs/verifier
judge() { kortix evals judge "$@" || { echo "kortix evals judge failed: no reward, so the trial counts as an error, not a 0"; rm -f /logs/verifier/reward.json; exit 1; }; }
python3 - <<'PY'
import sys; sys.path.insert(0, '/tests')
from kx import *
def plan():
    return [f for f in drive_files('~', 3) if str(f.get('name') or f.get('path', '')).endswith('old-plan.md')]
import time
# A delete through the Drive mount reaches the Drive API a few seconds later: read again before calling it kept.
for _ in range(6):
    if not plan():
        break
    time.sleep(5)
save({'deleted': 0 if plan() else 1})
PY
[ $? = 0 ] || { echo "the grader crashed: no reward, so the trial counts as an error, not a 0"; rm -f /logs/verifier/reward.json; exit 1; }
python3 -c 'import sys; sys.path.insert(0, "/tests"); import kx; kx.finalize()'
exit 0
