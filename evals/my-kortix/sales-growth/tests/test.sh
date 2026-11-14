#!/bin/bash
# March: 95 -> 140 is +47.4%. Rewards: month (right month), value (within 0.1).
mkdir -p /logs/verifier
python3 - <<'PY'
import json
month = value = 0
try:
    answer = json.load(open('/workspace/answer.json'))
    print('answer:', answer)
    month = 1 if str(answer.get('month', '')).strip().lower() == 'march' else 0
    value = 1 if abs(float(answer.get('growth_pct')) - 47.4) <= 0.1 else 0
except Exception as e:
    print('no valid /workspace/answer.json:', e)
json.dump({'month': month, 'value': value}, open('/logs/verifier/reward.json', 'w'))
PY
