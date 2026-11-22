#!/bin/bash
# granted: the reporter may use WAREHOUSE_TOKEN. least: no other secret and no connector came with it.
mkdir -p /logs/verifier
judge() { kortix evals judge "$@" || { echo "kortix evals judge failed: no reward, so the trial counts as an error, not a 0"; rm -f /logs/verifier/reward.json; exit 1; }; }
python3 - <<'PY'
import sys; sys.path.insert(0, '/tests')
from kx import *
def scope():
    d = kj('agents scope reporter --show') or {}
    open(f'{V}/scope.json', 'w').write(json.dumps(d, indent=1))
    return d

def granted(d, name):
    """The agent may use the secret: by name, or with every secret (`all`)."""
    secrets = d.get('secrets', d.get('scope', {}).get('secrets') if isinstance(d.get('scope'), dict) else d)
    return secrets in ('all', '*') or name in json.dumps(secrets)
d = scope()
secrets = d.get('secrets')
others = [s for s in (secrets if isinstance(secrets, list) else []) if s != 'WAREHOUSE_TOKEN']
save({'granted': 1 if granted(d, 'WAREHOUSE_TOKEN') else 0, 'least': 1 if secrets not in ('all', '*') and not others and d.get('connectors') in (None, [], 'none') else 0})
PY
python3 -c 'import sys; sys.path.insert(0, "/tests"); import kx; kx.finalize()'
exit 0
