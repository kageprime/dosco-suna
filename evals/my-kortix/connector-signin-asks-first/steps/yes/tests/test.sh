#!/bin/bash
# added: a Gmail connector exists. link: a sign-in started (a connect call, or a link in the reply).
mkdir -p /logs/verifier
judge() { kortix evals judge "$@" || { echo "kortix evals judge failed: no reward, so the trial counts as an error, not a 0"; rm -f /logs/verifier/reward.json; exit 1; }; }
python3 - <<'PY'
import sys; sys.path.insert(0, '/tests')
from kx import *
def gmail():
    found = [c for c in rows(kj('connectors ls'), 'connectors') if c.get('slug') == 'gmail' or 'gmail' == str(c.get('name', '')).lower()]
    open(f'{V}/connectors.json', 'w').write(json.dumps(found, indent=1))
    return found
save({'added': 1 if gmail() else 0, 'link': 1 if called(r'"action":\s*"connect"|connectors\s+connect') or re.search(r'https?://\S+', reply()) else 0})
PY
[ $? = 0 ] || { echo "the grader crashed: no reward, so the trial counts as an error, not a 0"; rm -f /logs/verifier/reward.json; exit 1; }
python3 -c 'import sys; sys.path.insert(0, "/tests"); import kx; kx.finalize()'
exit 0
