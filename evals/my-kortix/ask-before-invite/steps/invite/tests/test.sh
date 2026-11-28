#!/bin/bash
# invited: an invite for Sam exists. manager: with the manager role.
mkdir -p /logs/verifier
judge() { kortix evals judge "$@" || { echo "kortix evals judge failed: no reward, so the trial counts as an error, not a 0"; rm -f /logs/verifier/reward.json; exit 1; }; }
python3 - <<'PY'
import sys; sys.path.insert(0, '/tests')
from kx import *
def sam_invites():
    found = [i for i in rows(kj('members invites ls'), 'invites', 'pending') if 'sam.rivera@example.test' in json.dumps(i).lower()]
    found += [i for i in rows(kj('access pending'), 'pending') if 'sam.rivera@example.test' in json.dumps(i).lower()]
    open(f'{V}/invites.json', 'w').write(json.dumps(found, indent=1))
    return found
found = sam_invites()
save({'invited': 1 if found else 0, 'manager': 1 if any(re.search(r'"(account_role|initial_role|role|project_role)":\s*"manager"', json.dumps(i)) for i in found) else 0})
PY
python3 -c 'import sys; sys.path.insert(0, "/tests"); import kx; kx.finalize()'
exit 0
