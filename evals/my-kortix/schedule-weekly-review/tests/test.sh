#!/bin/bash
# has_loop + schedule: a loop on this session fires Mondays 09:00 Europe/Berlin (parsed, 5- or 6-field cron).
# no_shell_cron: nothing in crontab. about_metrics: judged. The loops are removed after grading.
mkdir -p /logs/verifier
kortix loops ls --session "$KORTIX_SESSION_ID" --json > /logs/verifier/loops.json 2>/logs/verifier/loops.err
cat /logs/verifier/loops.json
python3 - <<'PY'
import json, subprocess
loops = []
try:
    d = json.load(open('/logs/verifier/loops.json'))
    loops = d if isinstance(d, list) else (d.get('reminders') or d.get('loops') or [])
except Exception as e:
    print('no loops:', e)
def weekly(loop):
    cron = (loop.get('cron') or '').split()
    if len(cron) == 6: cron = cron[1:]
    if len(cron) != 5: return False
    minute, hour, _dom, _mon, dow = cron
    return minute in ('0', '00') and hour in ('9', '09') and dow.upper() in ('1', 'MON') and loop.get('timezone') == 'Europe/Berlin'
cron = subprocess.run('crontab -l 2>/dev/null', shell=True, capture_output=True, text=True).stdout.strip()
r = {'has_loop': 1 if loops else 0, 'schedule': 1 if any(weekly(l) for l in loops) else 0, 'no_shell_cron': 0 if cron else 1}
print(r)
json.dump(r, open('/logs/verifier/reward.json', 'w'))
PY
kortix evals judge \
  --criterion about_metrics="A loop's text is about reviewing the weekly metrics." \
  --input /logs/verifier/loops.json || { echo "kortix evals judge failed: no reward, so the trial counts as an error, not a 0"; rm -f /logs/verifier/reward.json; exit 1; }
for id in $(python3 -c 'import json; d=json.load(open("/logs/verifier/loops.json")); print(" ".join(l["id"] for l in (d if isinstance(d, list) else d.get("reminders") or d.get("loops") or [])))' 2>/dev/null); do kortix loops rm "$id" >/dev/null 2>&1; done
exit 0
