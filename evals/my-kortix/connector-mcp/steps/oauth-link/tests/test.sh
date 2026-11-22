#!/bin/bash
# linear: a Linear connector exists, waiting for its sign-in. link: the reply carries a sign-in link. in_chat: it starts the sign-in here, never "go to Settings" (judged).
mkdir -p /logs/verifier
judge() { kortix evals judge "$@" || { echo "kortix evals judge failed: no reward, so the trial counts as an error, not a 0"; rm -f /logs/verifier/reward.json; exit 1; }; }
python3 - <<'PY'
import sys; sys.path.insert(0, '/tests')
from kx import *
found = [c for c in rows(kj('connectors ls'), 'connectors') if 'linear' in f"{c.get('slug')} {c.get('name')}".lower()]
open(f'{V}/connectors.json', 'w').write(json.dumps(found, indent=1))
# The sign-in reaches the person as a link in the reply or as the Sign in card of a connect call.
card = called(r'"action":\s*"connect"|connectors\s+connect')
save({'linear': 1 if found else 0, 'link': 1 if card or re.search(r'https?://\S+', reply()) else 0})
PY
judge \
  --criterion in_chat="The reply starts the Linear sign-in here: a sign-in link, or a Sign in card it points to in this chat. It does not send the person to a settings screen to connect it." \
  --input /logs/agent/response.md
python3 -c 'import sys; sys.path.insert(0, "/tests"); import kx; kx.finalize()'
exit 0
