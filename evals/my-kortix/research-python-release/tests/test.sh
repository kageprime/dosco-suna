#!/bin/bash
# version: the reply names the release python.org lists now (read at grading time). cites: it links its source.
mkdir -p /logs/verifier
judge() { kortix evals judge "$@" || { echo "kortix evals judge failed: no reward, so the trial counts as an error, not a 0"; rm -f /logs/verifier/reward.json; exit 1; }; }
python3 - <<'PY'
import sys; sys.path.insert(0, '/tests')
from kx import *
page = sh('curl -sL -m 30 https://www.python.org/downloads/')
m = re.search(r'Download Python (\d+\.\d+\.\d+)', page)
if not m:
    print('python.org did not answer: no truth to grade against'); sys.exit(1)
text = reply()
save({'version': 1 if m.group(1) in text else 0, 'cites': 1 if re.search(r'https?://\S*python\.org', text) else 0})
PY
python3 -c 'import sys; sys.path.insert(0, "/tests"); import kx; kx.finalize()'
exit 0
