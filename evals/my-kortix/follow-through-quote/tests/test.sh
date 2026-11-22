#!/bin/bash
# check_in: a live loop on this session fires within 1 to 72 hours. no_offer: the reply never asks "want me to check later?". text + one_line: judged.
mkdir -p /logs/verifier
judge() { kortix evals judge "$@" || { echo "kortix evals judge failed: no reward, so the trial counts as an error, not a 0"; rm -f /logs/verifier/reward.json; exit 1; }; }
python3 - <<'PY'
import sys; sys.path.insert(0, '/tests')
from kx import *
import datetime
OFFER = re.compile(r"(want me to|do you want me to|should I|shall I|would you like me to)[^.!?\n]{0,160}\b(check|follow[ -]?up|remind|chase|ping|keep an eye|monitor|nudge)[^.!?\n]{0,160}\?", re.I)
now = datetime.datetime.now(datetime.timezone.utc)
loops = rows(kj(f'loops ls --session {SESSION}'), 'reminders', 'loops')
open(f'{V}/loops.json', 'w').write(json.dumps(loops, indent=1))
def due(l):
    if (l.get('state') or '') in ('done', 'paused', 'cancelled'): return False
    at = l.get('next_fire_at') or l.get('at')
    if not at: return bool(l.get('every') or l.get('cron'))
    t = datetime.datetime.fromisoformat(at.replace('Z', '+00:00'))
    return datetime.timedelta(hours=1) <= t - now <= datetime.timedelta(hours=72)
save({'check_in': 1 if any(due(l) for l in loops) else 0, 'no_offer': 0 if OFFER.search(reply()[-4000:]) else 1})
PY
judge \
  --criterion text="A loop's text says what is pending (the flour supplier's price quote) and what the check-in does: ask the person whether the quote came in." \
  --criterion one_line="The reply tells the person in one short line when it will check in, and does not ask whether it should." \
  --input /logs/verifier/loops.json \
  --input /logs/agent/response.md
python3 -c 'import sys; sys.path.insert(0, "/tests"); import kx; kx.finalize()'
exit 0
