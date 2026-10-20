---
recorded: 2026-10-20T11:53:42Z
incident_date: 2026-10-20
---
# Set the DB pool above the slots a burst can hold when auth stalls

**Rule:** Size the DB pool above the slots a retry burst can hold, and treat `db_pool_wait_suspected` in request logs as a site-wide outage signature, not a slow page.

**Trigger surface:** Sizing DB pool knobs for a deploy, or triaging a delay cascade where every route times out at the shared deadline while auth timings look fast.

**Incident:** 2026-10-20, release v32 day. A Supabase auth stall (gotrue calls at 1.4 s spiking to 25 s) met the runtime tokens going inactive at the same minute: the daemons and the dashboard started retry loops, each request held a slot across a multi-second auth phase, and the 10-slot pool wedged — `db;dur≈25 s` pool waits, `db_pool_wait_suspected: true`, every route at the 25 s deadline for ~15 min. Raising the pool and restarting the dyno drained it immediately; `/health` went 4.8 s → 264 ms.

**Enforcement:** none yet: a deploy health probe asserting `/health` < 1 s on two requests a minute apart would catch a half-recovered pool. Today the knob lives in the Heroku runbook and the value stays above 20.
