#!/bin/bash
# Break the schedule the way a person would: turn it off.
python3 - <<'PY'
import sys; sys.path.insert(0, '/tests')
from kx import *
def triggers():
    """Every scheduled trigger of the workspace, kortix.yaml and runtime: [{id, kind, cron, timezone, enabled}]."""
    data = kj('triggers ls') or {}
    out = []
    for t in rows(data, 'triggers'):
        out.append({'id': t.get('slug'), 'kind': 'yaml', 'cron': t.get('cron') or '', 'timezone': t.get('timezone') or '', 'enabled': t.get('enabled') is not False, 'type': t.get('type')})
    for t in rows(data, 'runtime'):
        src = t.get('source') or {}
        out.append({'id': t.get('id'), 'kind': 'runtime', 'cron': src.get('cron') or '', 'timezone': src.get('timezone') or t.get('timezone') or '', 'enabled': (t.get('state') or 'active') == 'active', 'type': src.get('type'), 'origin': t.get('origin')})
    return out

def weekday_8_berlin(t):
    parts = t['cron'].split()
    if len(parts) == 6: parts = parts[1:]
    if len(parts) != 5: return False
    minute, hour, _dom, _mon, dow = parts
    return minute in ('0', '00') and hour in ('8', '08') and dow.upper() in ('1-5', 'MON-FRI') and t['timezone'] == 'Europe/Berlin'

def fires(t):
    """Fire it now: its run starts a session (the session is the trigger agent's: the run says so, not the session)."""
    # Fire it: the API answers with the run and the session it started, and `fire` prints that session's id. Its
    # follow-up read of the session, and `triggers runs`, may not see it from here: the session is the trigger
    # agent's, and a session token opens only its own.
    out = sh(f"kortix triggers {'fire' if t['kind'] == 'yaml' else 'run'} {t['id']} 2>&1", timeout=200)
    print('fire', out[-400:])
    runs = rows(kj(f"triggers runs {t['id']}"), 'runs') if t['kind'] == 'yaml' else []
    print('runs', [(r.get('status'), r.get('session_id')) for r in runs])
    return bool(re.search(r'session [0-9a-f]{8}-[0-9a-f-]{27}', out)) or any(r.get('session_id') and r.get('status') in ('fired', 'running') for r in runs)
for t in triggers():
    if weekday_8_berlin(t):
        print(t)
        if t['kind'] == 'yaml': print(sh(f"kortix triggers disable {t['id']} --apply 2>&1"))
        else: print(sh(f"kortix triggers pause {t['id']} 2>&1"))
PY
