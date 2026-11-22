#!/bin/bash
# saved: a CSV is in the person's Drive. five_rows + right_order: Germany, France, Italy, Spain, Poland, with a population each.
mkdir -p /logs/verifier
judge() { kortix evals judge "$@" || { echo "kortix evals judge failed: no reward, so the trial counts as an error, not a 0"; rm -f /logs/verifier/reward.json; exit 1; }; }
python3 - <<'PY'
import sys; sys.path.insert(0, '/tests')
from kx import *
import csv, io
csvs = [f for f in drive_files('~') if str(f.get('name', '')).lower().endswith('.csv')]
ok = csvs and drive_get(csvs[0].get('path') or f"~/{csvs[0]['name']}", '/tmp/out.csv')
data = [r for r in csv.reader(io.StringIO(open('/tmp/out.csv').read()))] if ok else []
body = [r for r in data if r and not re.search(r'country|name', r[0], re.I)]
order = ['germany', 'france', 'italy', 'spain', 'poland']
names = [r[0].strip().lower() for r in body]
counted = all(len(r) > 1 and re.sub(r'[^0-9]', '', ''.join(r[1:])) for r in body)
save({'saved': 1 if ok else 0, 'five_rows': 1 if len(body) == 5 and counted else 0, 'right_order': 1 if names == order else 0})
PY
python3 -c 'import sys; sys.path.insert(0, "/tests"); import kx; kx.finalize()'
exit 0
