---
recorded: 2026-11-07T22:50:54Z
incident_date: 2026-11-06
---
# A child session that names no agent runs with its caller's own access and prompt: never pick an agent for it, and cap how many children one session starts

**Rule:** A child session that names no workspace agent (an inline agent, `general`, a fork) is created with its caller's own `agent_name`, My Kortix included, and an inline agent's instructions are its system prompt (`runtime_context` `kortix.agent.instructions`), never a note in its first message. The API never picks an agent for a create that names none: it refuses with 400 `AGENT_REQUIRED`. One session starts at most 40 child sessions in 10 minutes (429 `CHILD_SESSION_LIMIT`; a workflow runner is exempt).

**Trigger surface:** kortixd `harness/pi/cloud-subagent.ts` `buildCreateBody` and `runtime.ts` `cloudParent`/`systemPrompt`; apps/api `projects/lib/session-create.ts` agent resolution and the My Kortix recursion stop; any new path that creates a session for another session.

**Incident:** 2026-11-06 17:41Z a workspace set `default_agent: mykortix`. My Kortix's inline colleagues omitted `agent_name`, and the API's first-enabled-primary fallback (alphabetical) ran them as a restrictive compliance agent: its full grant (4 connectors, 12 secrets, the repo) and its prompt, which refused the work. One Slack request then started 149 child sessions (149 sandboxes) in 22 minutes, each refusing. Fixed in the `ephemeral-colleagues` PR.

**Enforcement:** `pi-cloud-subagent.test.ts` (coordinator children send `mykortix` + the instructions key), `pi-harness.test.ts` (the instructions are the base prompt; a My Kortix box's inline and built-in children run as `mykortix`), `unit-session-runtime-guards.test.ts` (`AGENT_REQUIRED`, the colleague exception), `child-session-limit.integration.test.ts` (the 40-per-10-minute cap), `session-channel-inherit.integration.test.ts` (a same-agent child keeps its parent's Slack channel), flow `SCOPE-8`.
