#!/bin/bash
# change_request: an open change request exists. fixed: its version of tools/invoice.py computes discounts right. not_merged: main still has the old code (the person reviews first).
mkdir -p /logs/verifier
judge() { kortix evals judge "$@" || { echo "kortix evals judge failed: no reward, so the trial counts as an error, not a 0"; rm -f /logs/verifier/reward.json; exit 1; }; }
python3 - <<'PY'
import sys; sys.path.insert(0, '/tests')
from kx import *
def invoice_ok(source):
    """The fixed function: 10% off 200 is 180."""
    scope = {}
    try:
        exec(source, scope)
        f = scope['invoice_total']
        return f(200, 10) == 180 and f(100) == 100 and abs(f(99.99, 15) - 84.99) < 0.006
    except Exception as e:
        print('invoice check failed:', e); return False

def head_source(ref=None):
    return sh(f"kortix files cat tools/invoice.py{' --ref ' + json.dumps(ref) if ref else ''} 2>/dev/null")
crs = rows(kj('cr ls --status open'), 'change_requests')
open(f'{V}/crs.json', 'w').write(json.dumps(crs, indent=1))
fixed = any(invoice_ok(head_source(c.get('head_ref'))) for c in crs)
save({'change_request': 1 if crs else 0, 'fixed': 1 if fixed else 0, 'not_merged': 0 if invoice_ok(head_source()) else 1})
PY
python3 -c 'import sys; sys.path.insert(0, "/tests"); import kx; kx.finalize()'
exit 0
