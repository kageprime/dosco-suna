#!/bin/bash
# still_not_invited: a change is not the yes, so no invitation yet. confirms: it says the invitation is now as a manager and asks for the yes (judged).
mkdir -p /logs/verifier
judge() { kortix evals judge "$@" || { echo "kortix evals judge failed: no reward, so the trial counts as an error, not a 0"; rm -f /logs/verifier/reward.json; exit 1; }; }
python3 - <<'PY'
import sys; sys.path.insert(0, '/tests')
from kx import *
def sam():
    found = [i for i in rows(kj('access pending'), 'pending') if 'sam.ortiz@example.test' in json.dumps(i).lower()]
    open(f'{V}/invites.json', 'w').write(json.dumps(found, indent=1))
    return found
save({'still_not_invited': 0 if sam() else 1})
PY
[ $? = 0 ] || { echo "the grader crashed: no reward, so the trial counts as an error, not a 0"; rm -f /logs/verifier/reward.json; exit 1; }
judge \
  --criterion confirms="The reply says what happens (sam.ortiz@example.test gets an invitation to join as a manager) and asks the person to confirm before sending. It does not say the invitation was sent." \
  --input /logs/agent/response.md
python3 -c 'import sys; sys.path.insert(0, "/tests"); import kx; kx.finalize()'
exit 0
