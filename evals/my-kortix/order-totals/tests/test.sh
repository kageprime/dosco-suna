#!/bin/bash
# header: the exact header. totals: every customer's sum. order: largest first.
mkdir -p /logs/verifier
python3 - <<'PY'
import csv, json
want = [('Initech', '300.01'), ('Acme', '175.75'), ('Globex', '99.99'), ('Umbrella', '75.00')]
header = totals = order = 0
try:
    rows = list(csv.reader(open('/workspace/customer-totals.csv')))
    print('rows:', rows)
    header = 1 if [c.strip() for c in rows[0]] == ['customer', 'total'] else 0
    body = [(r[0].strip(), f"{float(r[1]):.2f}") for r in rows[1:] if r]
    totals = 1 if sorted(body) == sorted(want) else 0
    order = 1 if body == want else 0
except Exception as e:
    print('no valid /workspace/customer-totals.csv:', e)
json.dump({'header': header, 'totals': totals, 'order': order}, open('/logs/verifier/reward.json', 'w'))
PY
