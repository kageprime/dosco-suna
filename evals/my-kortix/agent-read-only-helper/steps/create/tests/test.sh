#!/bin/bash
# exists: web-scout exists. no_secrets / no_connectors / no_permissions: the grants are omitted or none (omitted means none). no_writes: its tools leave out write, edit and bash.
mkdir -p /logs/verifier
judge() { kortix evals judge "$@" || { echo "kortix evals judge failed: no reward, so the trial counts as an error, not a 0"; rm -f /logs/verifier/reward.json; exit 1; }; }
python3 - <<'PY'
import sys; sys.path.insert(0, '/tests')
from kx import *
cfg = kj('agents config web-scout') or {}
block = cfg.get('block') or {}
open(f'{V}/web-scout.json', 'w').write(json.dumps(cfg, indent=1))
none = lambda v: v in (None, 'none', [], '') 
tools = block.get('tools')
names = [str(t).lower() for t in tools] if isinstance(tools, list) else (list(tools) if isinstance(tools, dict) else [])
writes = tools in (None, 'all', '*') or any(re.fullmatch(r'write|edit|bash|apply_patch|multiedit', n) for n in names) or (isinstance(tools, dict) and any(tools.get(k) not in (False, 'deny') for k in ('write', 'edit', 'bash')))
save({'exists': 1 if block else 0, 'no_secrets': 1 if block and none(block.get('secrets')) else 0, 'no_connectors': 1 if block and none(block.get('connectors')) else 0,
      'no_permissions': 1 if block and none(block.get('kortix_permissions', block.get('kortix_cli'))) else 0, 'no_writes': 1 if block and not writes else 0})
PY
[ $? = 0 ] || { echo "the grader crashed: no reward, so the trial counts as an error, not a 0"; rm -f /logs/verifier/reward.json; exit 1; }
python3 -c 'import sys; sys.path.insert(0, "/tests"); import kx; kx.finalize()'
exit 0
