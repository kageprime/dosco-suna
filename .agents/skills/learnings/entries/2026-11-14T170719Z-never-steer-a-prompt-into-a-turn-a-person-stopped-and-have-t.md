---
recorded: 2026-11-14T17:07:19Z
incident_date: 2026-11-13
---
# Never steer a prompt into a turn a person stopped, and have the runtime report every steer it drops

**Rule:** A Stop's hold is released before the client's abort reaches the box, so the stopped turn can still accept a steer. Admission never steers into a turn whose `session_turns` record carries a requested stop (`UserStop`): the prompt waits for that turn's end and starts the next one. A runtime that drops a steer it accepted (pi drops every unread steer of a stopped turn) reports it (`steer_dropped`), and apps/api puts the row back on the queue. A forwarded steer with no reader is a lost message: never close one as delivered on id order alone.

**Trigger surface:** Changing the prompt inbox (admission, the Stop hold and its settle, the release), steering, or how kortixd ends a turn.

**Incident:** 2026-11-13, prod v0.15.10. A teammate's queued message showed "Read at next step", was never answered, and vanished on a second Stop. The release steered it into the turn being stopped about 250 ms before the abort; pi dropped it; the next Stop closed the row as delivered (KRTX-4864, #12647, fixed that half). Prod, 7 days: 3 of 3 prompts released by a Stop and then steered were lost. #12741 fixed the cause.

**Enforcement:** `apps/api/src/__tests__/integration-prompt-inbox.test.ts` ("a row is never steered into a turn a person stopped", "steer_dropped puts a steer …"), `apps/kortix-sandbox-agent-server/src/__tests__/pi-harness.test.ts` ("a stopped turn drops its unread steered messages, reports each one …"), and flow `SESS-65` on a real pi box in the release suite (fails on the pre-fix admission in 7 s).
