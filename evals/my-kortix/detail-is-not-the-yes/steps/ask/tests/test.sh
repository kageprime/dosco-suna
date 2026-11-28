#!/bin/bash
# not_invited: no invitation yet. asked: one question (the role, or the confirmation).
mkdir -p /logs/verifier
judge() { kortix evals judge "$@" || { echo "kortix evals judge failed: no reward, so the trial counts as an error, not a 0"; rm -f /logs/verifier/reward.json; exit 1; }; }
python3 - <<'PY'
import sys; sys.path.insert(0, '/tests')
from kx import *
def sam():
    found = [i for i in rows(kj('access pending'), 'pending') if 'sam.ortiz@example.test' in json.dumps(i).lower()]
    open(f'{V}/invites.json', 'w').write(json.dumps(found, indent=1))
    return found
save({'not_invited': 0 if sam() else 1, 'asked': 1 if asked_person() else 0})
PY
[ $? = 0 ] || { echo "the grader crashed: no reward, so the trial counts as an error, not a 0"; rm -f /logs/verifier/reward.json; exit 1; }
python3 -c 'import sys; sys.path.insert(0, "/tests"); import kx; kx.finalize()'
exit 0
