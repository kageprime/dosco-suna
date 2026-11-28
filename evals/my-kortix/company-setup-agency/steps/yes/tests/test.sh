#!/bin/bash
# writer: content-writer exists with no secrets and no connectors. schedule: one Monday 09:00 Europe/Berlin agent trigger, paused or already tested. invite: Ana is invited as a member.
mkdir -p /logs/verifier
judge() { kortix evals judge "$@" || { echo "kortix evals judge failed: no reward, so the trial counts as an error, not a 0"; rm -f /logs/verifier/reward.json; exit 1; }; }
python3 - <<'PY'
import sys; sys.path.insert(0, '/tests')
from kx import *
def writer():
    return (kj('agents config content-writer') or {}).get('block') or {}
def ana():
    return [i for i in rows(kj('access pending'), 'pending') if 'ana@example.test' in json.dumps(i).lower()]
def report():
    data = kj('triggers ls') or {}
    found = [t for t in rows(data, 'triggers') + rows(data, 'runtime') if (t.get('target') or {}).get('kind') != 'session' and re.search(r'(^|\s)9\s+\*\s+\*\s+(1|MON)\b', str(t.get('cron') or (t.get('source') or {}).get('cron') or ''), re.I)]
    open(f'{V}/state.json', 'w').write(json.dumps({'writer': writer(), 'ana': ana(), 'report': found, 'all_triggers': data, 'loops': kj('loops ls')}, indent=1))
    return found
def live(t):
    return t.get('state') not in ('paused', 'disabled', 'done') and t.get('enabled') is not False and not t.get('auto_paused_at')
def ran(t):
    return any(t.get(k) for k in ('last_fired_at', 'last_status', 'last_run_at', 'last_event_at'))
none = lambda v: v in (None, 'none', [], '')
w = writer(); found = report()
save({'writer': 1 if w and none(w.get('secrets')) and none(w.get('connectors')) else 0,
      'schedule': 1 if len(found) == 1 and 'berlin' in str(found[0].get('timezone') or (found[0].get('source') or {}).get('timezone') or '').lower() and (not live(found[0]) or ran(found[0])) else 0,
      'invite': 1 if any(re.search(r'"(project_role|role)":\s*"member"', json.dumps(i)) for i in ana()) else 0})
PY
[ $? = 0 ] || { echo "the grader crashed: no reward, so the trial counts as an error, not a 0"; rm -f /logs/verifier/reward.json; exit 1; }
python3 -c 'import sys; sys.path.insert(0, "/tests"); import kx; kx.finalize()'
exit 0
