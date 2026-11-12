---
recorded: 2026-11-11T22:31:33Z
incident_date: 2026-10-31
---
# When a credential moves to a new store, move every reader with it and prove it with a model call outside a session

**Rule:** When a credential gets a new store, every reader moves in the same PR: the gateway's request path with and without a session selection, model servability, default-model fallbacks, trigger pre-checks, the CLI's writes, and the web panel. Turning such a store on by default needs a flow that adds a key the way the product does and then calls a model outside any session (a gateway API key, the playground) and from a session with no selection.

**Trigger surface:** Adding or changing a store for provider keys, accounts or logins (`project_secrets`, `account_secret_resources`, subscription logins); flipping a feature flag's platform default; changing where the Models panel, CLI or TUI writes a credential.

**Incident:** 2026-10-31 #11335 turned `pooled_provider_secrets` on for every project. From then on the Models panel saved API keys as account secret resources, but the gateway read them only through a session's stored key selection. Every other caller read the legacy project secret and answered `400 provider_not_connected` "No <provider> API key is connected for this project" with a key in the panel: the playground and `kortix gateway test`, gateway API keys, sessions started without a selection, triggers. Session creation hid it for explicit-model sessions by storing an automatic selection, which then broke when its key was deleted. Prod `provider_not_connected` went from 2–3 a day to 86–93 a day (2026-11-05, 2026-11-08); 403 refusals in 61 projects in the 7 days to 2026-11-11, when a customer reported it. Fixed on branch `gateway-named-keys`.

**Enforcement:** flow `SEC-POOL-7` (`tests/src/flows/secrets.flow.ts`): a Models-panel key reaches the provider from the playground, a gateway API key and a session with no selection; it failed with the incident's error before the fix. Unit tests in `resolve-candidates.test.ts` ("Models-panel keys without a session selection") and `default-model.test.ts`.
