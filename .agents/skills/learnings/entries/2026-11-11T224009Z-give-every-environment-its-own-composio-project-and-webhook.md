---
recorded: 2026-11-11T22:40:09Z
incident_date: 2026-11-11
---
# Give every environment its own Composio project and webhook, and never let a webhook be the only path that records a signed-in account

**Rule:** Each environment (prod, staging, dev, local) gets its own Composio project, its own `COMPOSIO_API_KEY`, and one webhook subscription that points at that environment's own API (`https://<api-host>/v1/webhooks/events/composio`) and is signed with that environment's `COMPOSIO_WEBHOOK_SECRET`. A provider webhook is a redundancy, never the only path that records an account: the gateway asks Composio before it answers `needs_auth` for a row whose sign-in started (`recordFinishedComposioAuthorization`). When a person says "Composio said connected but Kortix does not work", compare the row's `metadata.connected_account_id` with `GET /api/v3/connected_accounts?user_ids=kortix-connection:<connection_id>` and list `GET /api/v3/webhook_subscriptions` with the same key.

**Trigger surface:** Adding or rotating a Composio key or webhook secret, creating a webhook subscription, adding a connect surface that hands out a raw provider link (the CLI `kortix connectors connect`, an agent prompt), or a report that a connector "does not work" after a successful provider sign-in page.

**Incident:** 2026-11-11, Kortix v0.15.7 prod.
- An agent ran `kortix connectors connect gmail` (raw Composio link, no Kortix page). The person saw "Successfully connected" at Composio. Every call answered `needs_auth`.
- Composio held the account `ACTIVE`. The Kortix row kept `connected_account_id: null`: no finalize ran. The settings Reconnect fixed a private row because a new connect start reads Composio's state first.
- The prod and dev keys belonged to one Composio project. Its only webhook subscription pointed at the dev API and used dev's secret, so prod never received `composio.connected_account.activated`. Prod Composio event triggers had never received an event.
- 14 days: 5 prod rows in 5 workspaces were ACTIVE at Composio and unrecorded in Kortix; 39 more were EXPIRED at Composio (sign-in never finished).
- The dev key could read prod connected accounts: an isolation gap in the same project.

**Enforcement:** `apps/api/src/connectors/composio-unrecorded-sign-in.integration.test.ts` (the first call records a finished sign-in; an unfinished one writes nothing) and the fail-closed case in `apps/api/src/connectors/composio.test.ts`. Environment isolation: none yet: a deploy check that lists the Composio webhook subscriptions with the environment's key and fails unless exactly one points at that environment's API.
