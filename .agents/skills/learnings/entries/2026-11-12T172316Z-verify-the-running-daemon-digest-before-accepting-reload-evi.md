---
recorded: 2026-11-12T17:23:16Z
incident_date: 2026-11-12
---
# Verify the running daemon digest before accepting reload evidence

**Rule:** Compare `/kortix/health` → `runtime.running.agent_sha256` with the locally built daemon before accepting streaming or reload evidence. A template name, successful build, or staged digest does not identify the running code.

**Trigger surface:** Verifying session streaming against a freshly provisioned sandbox or after a daemon update.

**Incident:** 2026-11-12, PR #12594. Reload probes used the fallback sandbox image while the new daemon waited in `agent.next`. The five-minute safety window deferred activation. After the supervisor activated the matching digest, the real reload retained the answer and continued appending text.

**Enforcement:** None yet: add a running-digest assertion to the browser streaming fixture. The session-log hook regression covers join puts and duplicate deltas; it does not verify the deployed daemon.
