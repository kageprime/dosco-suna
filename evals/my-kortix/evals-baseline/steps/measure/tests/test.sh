#!/bin/bash
# job + agent + three_tasks: an eval job ran (or runs) the support-replies agent on at least three tasks.
mkdir -p /logs/verifier
judge() { kortix evals judge "$@" || { echo "kortix evals judge failed: no reward, so the trial counts as an error, not a 0"; rm -f /logs/verifier/reward.json; exit 1; }; }
python3 - <<'PY'
import sys; sys.path.insert(0, '/tests')
from kx import *
jobs = rows(kj('evals jobs'), 'jobs')
open(f'{V}/jobs.json', 'w').write(json.dumps(jobs, indent=1)[:200000])
mine = [j for j in jobs if 'support-replies' in json.dumps((j.get('config') or {}).get('agents'))]
tasks = set()
for j in mine:
    shown = kj(f"evals show {j.get('job_id')}") or {}
    tasks |= {t.get('task_name') for t in rows(shown, 'trials') if t.get('task_name')}
save({'job': 1 if jobs else 0, 'agent': 1 if mine else 0, 'three_tasks': 1 if len(tasks) >= 3 else 0})
PY
python3 -c 'import sys; sys.path.insert(0, "/tests"); import kx; kx.finalize()'
exit 0
