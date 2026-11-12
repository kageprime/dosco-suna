---
recorded: 2026-11-10T13:34:49Z
incident_date: 2026-11-07
---
# Never let a queue's own claim and put-back write an audit row or a new copy of a large column

**Rule:** A queue row that waits is claimed and put back many times. That cycle writes only small columns: no audit row (an audit trigger records the insert and the outcome, not `queued`<->`running`), and no rewrite of a TOASTed column (stamp a mark once, then hand the stored value back). A row that cannot go next waits on the minute clock on every box. A row a drain claimed but that has not passed admission never counts as "in flight" for the head. When the head gives up on a runtime that is gone for good (a `failed` session), close the queue behind it in one statement instead of sending every follower through the same retry ladder.

**Trigger surface:** `apps/api/src/projects/session-lifecycle/` (`command-transitions.ts` requeue writers, `inbox-admission.ts` backoff and in-flight read, `drain.ts` batch release), any AFTER UPDATE audit trigger on a queue table, any `payload || ...` in a requeue path.

**Incident:** 2026-11-05 to 2026-11-10, prod. One failed session with a stopped box held a head prompt parked on `runtime_unreachable` and ~374 prompts behind it (another session added ~6). Every follower was claimed and put back at least once a minute; each cycle wrote two `kortix.audit_events` rows (the dedupe index includes `occurred_at`) and a new TOAST copy of the payload. Peak 307k audit rows per hour, 12.1M on 2026-11-07 (~15 GB/day); `session_lifecycle_commands` TOAST reached 25 GB against a 0.6 GB heap; the database grew ~10 GB/day toward a Supabase disk autoscale step. Each head walked the full three-park `runtime_unreachable` ladder (~12 min) before the next prompt became head, so the queue drained about one prompt per 20 minutes (505 rows on 2026-11-07, 375 on 2026-11-09), and the churn ran for days. A follower that a drain held `running` also refused the head as "in flight". Fixed in branch `admission-loop` (migration `20261110132451645`).

**Enforcement:** `apps/api/src/__tests__/integration-admission-loop.test.ts` (in-flight read, no payload rewrite by TOAST chunk id, no audit row for claim churn, failed-session dead-letter cascade, a drain run that ends the queue), `inbox-admission.test.ts` ("a row behind an older prompt waits a minute from its first refusal, on any box"). To build: an alert on `session_lifecycle_commands` rows with `admission_refusals` above 10,000, and on `audit_events` rows per hour per session.
