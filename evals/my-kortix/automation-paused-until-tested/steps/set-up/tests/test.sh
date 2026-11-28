#!/bin/bash
# scheduled: one weekday 09:00 Europe/London trigger that starts an agent. not_live_untested: it is paused, or it already ran once (its test). says_state: the reply says whether it is live (judged).
mkdir -p /logs/verifier
judge() { kortix evals judge "$@" || { echo "kortix evals judge failed: no reward, so the trial counts as an error, not a 0"; rm -f /logs/verifier/reward.json; exit 1; }; }
python3 - <<'PY'
import sys; sys.path.insert(0, '/tests')
from kx import *
def digests():
    data = kj('triggers ls') or {}
    found = [t for t in rows(data, 'triggers') + rows(data, 'runtime') if (t.get('target') or {}).get('kind') != 'session' and re.search(r'(^|\s)9\s+\*\s+\*\s+(1-5|MON-FRI)', str(t.get('cron') or (t.get('source') or {}).get('cron') or ''), re.I)]
    open(f'{V}/triggers.json', 'w').write(json.dumps({'matched': found, 'all': data, 'loops': kj('loops ls')}, indent=1))
    return found
def live(t):
    return t.get('state') not in ('paused', 'disabled', 'done') and t.get('enabled') is not False and not t.get('auto_paused_at')
def ran(t):
    return any(t.get(k) for k in ('last_fired_at', 'last_status', 'last_run_at', 'last_event_at'))
def london(t):
    return 'london' in str(t.get('timezone') or (t.get('source') or {}).get('timezone') or '').lower()
found = digests()
tested = [t for t in found if ran(t)]
save({'scheduled': 1 if len(found) == 1 and london(found[0]) else 0, 'not_live_untested': 1 if found and all(not live(t) or t in tested for t in found) else 0})
PY
[ $? = 0 ] || { echo "the grader crashed: no reward, so the trial counts as an error, not a 0"; rm -f /logs/verifier/reward.json; exit 1; }
judge \
  --criterion says_state="The reply says plainly whether the weekday digest is running yet: paused until it is tested, or tested and live. It does not call it live without a test run." \
  --input /logs/agent/response.md
python3 -c 'import sys; sys.path.insert(0, "/tests"); import kx; kx.finalize()'
exit 0
