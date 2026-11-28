---
recorded: 2026-11-26T15:03:18Z
incident_date: 2026-11-25
---
# A channel session binds its own channel connector without the agent's connectors grant

**Rule:** Gate a session's channel connector by the channel, never by the agent's `connectors:` grant. Session create and the call gate must give the same answer: `isSessionChannelConnector` (session-connector-bindings.ts) at create, `principalMayUseConnector` (connectors/principal-access.ts) at the call.

**Trigger surface:** Adding a check on `connector_bindings` in session create, or a channel whose session plan binds a connector (email binds its inbox).

**Incident:** 2026-11-25, prod v0.16.5. A customer bound an email inbox to an agent with `connectors: none`. Every inbound email answered 200, then its create dead-lettered with `Agent "<agent>" is not granted connector "email"`: no session, no notice, for about 5 h, 7 emails. The email port tells the sender nothing on `create_failed`, so the only trace was `session_lifecycle_commands.last_error`.

**Enforcement:** `apps/api/src/__tests__/integration-session-connector-connections.test.ts` ("an email session binds its inbox without the agent's connectors grant; nothing else does"). None yet for the silence: a create that fails for a channel message leaves no signal a workspace admin can see.
