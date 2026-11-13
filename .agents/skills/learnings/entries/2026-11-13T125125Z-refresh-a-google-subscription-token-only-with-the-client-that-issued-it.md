---
recorded: 2026-11-13T12:51:25Z
incident_date: 2026-11-13
---
# Refresh a Google subscription token only with the client that issued it, and refuse a credential with no Cloud Code project as provider_reauth_required

**Rule:** A Google OAuth refresh token is bound to the client that issued it: refreshing a Gemini CLI `oauth_creds.json` with the Antigravity client returns `invalid_grant`, and the expired access token cannot discover the Cloud Code project. Accept only a `ya29…` bearer (about 50 minutes) or an OAuth JSON from the same client. When a credential resolves without a Cloud Code project, answer `provider_reauth_required` with a reconnect suggestion; never let it reach the model as a generic 400.

**Trigger surface:** `apps/api/src/llm-gateway/credentials/antigravity.ts`, `resolution/resolve-candidates.ts` (`resolveAntigravityCandidates`), `packages/api-contract/src/antigravity.ts`, `packages/ui/src/customize/sections/llm-provider/antigravity-auth.ts`, and any new subscription provider that mints its own OAuth tokens.

**Incident:** 2026-11-13, prod (v136), one workspace: `gemini-3.8-flash-high` answered `400 {"message":"The request could not be built.","type":"invalid_request_error"}`. A pasted Gemini CLI credential refreshed against the Antigravity client, failed, left no project, and Cloud Code's envelope requires one. Fixed in `f307befde2` (build errors name their cause; the paste parser matches the contract) and `31b2956d75` (the project guard), deployed v137.

**Enforcement:** `packages/ui/src/customize/sections/llm-provider/antigravity-auth.test.ts` (an API key is rejected; a JSON keeps its project); `packages/llm-gateway/src/transports/ai-sdk/ai-sdk.test.ts` (a Cloud Code descriptor without a project fails as a 400 naming the cause, before any fetch); the `provider_reauth_required` guard in `resolveAntigravityCandidates`.