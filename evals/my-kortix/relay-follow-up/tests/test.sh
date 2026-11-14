#!/bin/bash
# has_followup: a live loop on this session fires within 1 to 72 hours. no_offer: the reply does not ask "want me to check later?".
# followup_text + one_line: judged. The loops are removed after grading.
mkdir -p /logs/verifier
kortix loops ls --session "$KORTIX_SESSION_ID" --json > /logs/verifier/loops.json 2>/logs/verifier/loops.err
python3 - <<'PY'
import json, datetime, os

import re
ASK = r"(?:want me to|do you want me to|should I|shall I|would you like me to|I can|I could|happy to)"
LATER = r"(?:check|watch|follow[ -]?up|remind|chase|ping|look again|keep an eye|monitor|nudge|circle back|let you know when|tell you when|get back to you|check back|report back)"
OFFER = re.compile(rf"[^.!?\n]{{0,200}}\b{ASK}\b[^.!?\n]{{0,160}}\b{LATER}[^.!?\n]{{0,160}}\?", re.I)
def no_offer(text): return 0 if OFFER.search(text[-4000:]) else 1

now = datetime.datetime.now(datetime.timezone.utc)
loops = []
try:
    d = json.load(open('/logs/verifier/loops.json'))
    loops = d if isinstance(d, list) else (d.get('reminders') or d.get('loops') or [])
except Exception as e:
    print('no loops:', e)
def due(loop):
    if (loop.get('state') or '') in ('done', 'paused', 'cancelled'): return False
    at = loop.get('next_fire_at') or loop.get('at')
    if not at: return bool(loop.get('every') or loop.get('cron'))
    t = datetime.datetime.fromisoformat(at.replace('Z', '+00:00'))
    return datetime.timedelta(hours=1) <= t - now <= datetime.timedelta(hours=72)
reply = open('/logs/agent/response.md').read() if os.path.exists('/logs/agent/response.md') else ''
r = {'has_followup': 1 if any(due(l) for l in loops) else 0, 'no_offer': no_offer(reply)}
print(loops, r)
json.dump(r, open('/logs/verifier/reward.json', 'w'))
PY
kortix evals judge \
  --criterion followup_text="A loop's text names the three bakeries (Brot & Co, Kornblume, Hefezopf) and says what the check-in does: ask the person which quotes came in." \
  --criterion one_line="The reply tells the person in one short line when it will check in about the three quotes, and does not ask whether it should." \
  --input /logs/verifier/loops.json --input /logs/agent/response.md || { echo "kortix evals judge failed: no reward, so the trial counts as an error, not a 0"; rm -f /logs/verifier/reward.json; exit 1; }
for id in $(python3 -c 'import json; d=json.load(open("/logs/verifier/loops.json")); print(" ".join(l["id"] for l in (d if isinstance(d, list) else d.get("reminders") or d.get("loops") or [])))' 2>/dev/null); do kortix loops rm "$id" >/dev/null 2>&1; done
exit 0
