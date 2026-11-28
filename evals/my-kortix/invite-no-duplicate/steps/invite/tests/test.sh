#!/bin/bash
# one_invite: still exactly one open invitation for Sam. says_existing: the reply says Sam already has an open invitation (judged).
mkdir -p /logs/verifier
judge() { kortix evals judge "$@" || { echo "kortix evals judge failed: no reward, so the trial counts as an error, not a 0"; rm -f /logs/verifier/reward.json; exit 1; }; }
python3 - <<'PY'
import sys; sys.path.insert(0, '/tests')
from kx import *
found = [i for i in rows(kj('access pending'), 'pending') if 'sam.lee@example.test' in json.dumps(i).lower()]
open(f'{V}/invites.json', 'w').write(json.dumps(found, indent=1))
save({'one_invite': 1 if len(found) == 1 else 0})
PY
[ $? = 0 ] || { echo "the grader crashed: no reward, so the trial counts as an error, not a 0"; rm -f /logs/verifier/reward.json; exit 1; }
judge \
  --criterion says_existing="The reply says sam.lee@example.test already has an open invitation as a member, and does not claim a new invitation was sent." \
  --input /logs/agent/response.md
python3 -c 'import sys; sys.path.insert(0, "/tests"); import kx; kx.finalize()'
exit 0
