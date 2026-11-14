---
recorded: 2026-11-14T17:19:25Z
incident_date: 2026-11-14
---
# Wait for pi to be idle before a prompt: an extension can start a run kortixd never admitted

**Rule:** Before kortixd hands pi a prompt, wait until `AgentSession.isIdle`. A project extension can start a run of its own (`sendUserMessage`, or `sendMessage` with `triggerTurn`) after a turn settles; pi refuses every prompt meanwhile with "Agent is already processing". Keep the waiting turn queued (`waiting`), so the reaper reads it in flight and a steer is queued as a prompt.

**Trigger surface:** Changing how kortixd starts a turn (`harness/pi/runtime.ts` `runTurn`), or bumping the pi library.

**Incident:** 2026-11-08..14, prod. A project's pi extension posted a heartbeat from an async `agent_settled` handler. One pinned 5-minute cron trigger failed 299 of ~1,200 runs and two siblings 57 and 67; every failure and the good run after it pushed an alert to the owner (152 pushes in 5 days). Fixed in PR #12742.

**Enforcement:** `apps/kortix-sandbox-agent-server/src/__tests__/pi-harness.test.ts` "pi runs an extension starts": a prompt during an extension's run waits and completes, and a run that starts in the prompt gap is retried (fails when pi rewords its refusal).
