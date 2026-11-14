#!/bin/bash
# owners: exactly Dana, Omar and Lee (no owner invented for the dashboard). dues: Friday, Wednesday, null. tasks: judged.
mkdir -p /logs/verifier
python3 - <<'PY'
import json
owners = dues = 0
try:
    items = json.load(open('/workspace/actions.json'))
    print('items:', items)
    by = {str(i.get('owner', '')).strip().lower(): i for i in items}
    owners = 1 if sorted(by) == ['dana', 'lee', 'omar'] else 0
    due = lambda o: (by.get(o, {}).get('due') or '').strip().lower() or None
    dues = 1 if due('dana') == 'friday' and due('omar') == 'wednesday' and due('lee') in (None, 'next week') else 0
except Exception as e:
    print('no valid /workspace/actions.json:', e)
json.dump({'owners': owners, 'dues': dues}, open('/logs/verifier/reward.json', 'w'))
PY
kortix evals judge \
  --criterion tasks="Each item's task says what the notes say that owner will do (pricing page copy, onboarding email, user interviews), without adding work the notes do not name." \
  --input /workspace/actions.json || { echo "kortix evals judge failed: no reward, so the trial counts as an error, not a 0"; rm -f /logs/verifier/reward.json; exit 1; }
