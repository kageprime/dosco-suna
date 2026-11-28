---
recorded: 2026-11-24T18:08:49Z
incident_date: 2026-11-24
---
# When you add a secret consumer, make every writer that rewrites a row's consumer skip it

**Rule:** A new `project_secret_consumer` value is a new kind of row. Before it ships, read every `update(projectSecrets)` and every function that sets `consumer`, `strategy` or `scope` (`confineSharedProjectSecretToConnector`, `PUT …/secrets/:identifier/strategy`, `POST …/secrets`, channel installs). Make each one skip or refuse the new kind. A rewrite that `kortix.yaml` can trigger is reachable by an agent.

**Trigger surface:** Adding a secret consumer or a secret kind; adding a code path that rewrites how a stored secret is delivered.

**Incident:** 2026-11-24, PR #13048 (website logins, `consumer: browser`), caught by a Strix review before merge. The connector sync rewrote any shared row a connector's `auth.secret` names. An agent that edits `kortix.yaml` could turn a person's website login into a connector credential and send the password to a host the agent chose. Fixed in the same PR.

**Enforcement:** `apps/api/src/__tests__/integration-browser-login-connector-binding.test.ts` binds an MCP connector to a login in `kortix.yaml` and syncs. Without the guard, all 3 tests fail, and the connector read returns the plaintext.
