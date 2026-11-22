#!/bin/bash
# live: an App of the workspace answers 200 at its URL. public: anyone can open it. hours: the page shows the opening hours.
mkdir -p /logs/verifier
judge() { kortix evals judge "$@" || { echo "kortix evals judge failed: no reward, so the trial counts as an error, not a 0"; rm -f /logs/verifier/reward.json; exit 1; }; }
python3 - <<'PY'
import sys; sys.path.insert(0, '/tests')
from kx import *
found = {'live': 0, 'public': 0, 'hours': 0}
for a in rows(kj('apps ls'), 'apps'):
    shown = kj(f"apps show {a.get('slug')}") or {}
    d = {**a, **(shown.get('app') or {})}
    url = d.get('url') or ''
    page = sh(f"curl -sL -m 30 {json.dumps(url)}") if url else ''
    open(f'{V}/page.html', 'w').write(page[:20000])
    if page: found['live'] = 1
    if d.get('access_mode') == 'public' or d.get('access') == 'public': found['public'] = 1
    if all(re.search(p, page, re.I) for p in (r'\b7(:00)?\b', r'\b18(:00)?\b', r'\b14(:00)?\b', r'sunday|sun\b')): found['hours'] = 1
save(found)
PY
python3 -c 'import sys; sys.path.insert(0, "/tests"); import kx; kx.finalize()'
exit 0
