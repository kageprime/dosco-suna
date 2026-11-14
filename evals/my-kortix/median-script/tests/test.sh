#!/bin/bash
# Each case is one reward: odd count, even count, unsorted with blanks and negatives, empty input.
mkdir -p /logs/verifier
python3 - <<'PY'
import json, subprocess
cases = {'odd': ('3\n1\n2\n', 2.0), 'even': ('1\n2\n3\n4\n', 2.5), 'messy': ('10\n\n-4\n7.5\n\n2\n', 4.75), 'empty': ('', 0.0)}
rewards = {}
for name, (stdin, want) in cases.items():
    try:
        out = subprocess.run(['python3', '/workspace/median.py'], input=stdin, capture_output=True, text=True, timeout=10).stdout.strip()
        rewards[name] = 1 if abs(float(out) - want) < 1e-9 else 0
        print(name, repr(out), 'want', want)
    except Exception as e:
        print(name, 'failed:', e)
        rewards[name] = 0
json.dump(rewards, open('/logs/verifier/reward.json', 'w'))
PY
