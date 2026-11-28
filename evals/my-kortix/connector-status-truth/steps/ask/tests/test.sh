#!/bin/bash
# unchanged: Notion is still added and waiting for its sign-in. truthful: the reply says it is added but not signed in, so agents cannot use it yet (judged).
mkdir -p /logs/verifier
judge() { kortix evals judge "$@" || { echo "kortix evals judge failed: no reward, so the trial counts as an error, not a 0"; rm -f /logs/verifier/reward.json; exit 1; }; }
python3 - <<'PY'
import sys; sys.path.insert(0, '/tests')
from kx import *
found = [c for c in rows(kj('connectors ls'), 'connectors') if c.get('slug') == 'notion']
open(f'{V}/connectors.json', 'w').write(json.dumps(found, indent=1))
save({'unchanged': 1 if found and all(not c.get('accounts') for c in found) else 0})
PY
[ $? = 0 ] || { echo "the grader crashed: no reward, so the trial counts as an error, not a 0"; rm -f /logs/verifier/reward.json; exit 1; }
judge \
  --criterion truthful="The reply says Notion is added to the workspace but no account is signed in, so agents cannot use it yet. It does not say Notion is connected, and it does not say Notion is missing." \
  --input /logs/agent/response.md
python3 -c 'import sys; sys.path.insert(0, "/tests"); import kx; kx.finalize()'
exit 0
