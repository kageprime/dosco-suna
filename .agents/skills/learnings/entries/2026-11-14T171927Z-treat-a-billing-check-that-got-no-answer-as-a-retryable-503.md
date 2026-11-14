---
recorded: 2026-11-14T17:19:27Z
incident_date: 2026-11-12
---
# Treat a billing check that got no answer as a retryable 503, never as a billing refusal

**Rule:** Only a billing verdict is a 402: a `BillingGateError` on the API, an error carrying `reason` on the gateway, an `InsufficientCreditsError` from the wallet. A timeout, an unreachable control plane or a `WalletUnavailableError` is no verdict: answer a retryable `503 admission_unavailable`, never `subscription_required` or `insufficient_credits`.

**Trigger surface:** Catching an error around a billing check: `packages/llm-gateway` `billingRefusal`, `apps/api` `billing-gate.ts`, `llm-gateway/admit.ts`, `llm-gateway/hooks.ts`.

**Incident:** 2026-11-12 19:11Z, prod. The control plane stalled 25 s; the gateway's billing call timed out ("attempt 3 exceeded 5000ms") and answered funded accounts `402 subscription_required`. Agents and trigger runs reported "Out of credits", and pi does not retry a billing error. Fixed in PR #12742.

**Enforcement:** `packages/llm-gateway/src/pipeline/simple-handler.test.ts` and `audio.test.ts` (an unanswered check is a 503), `apps/api/src/billing/services/billing-gate.test.ts` (a wallet fault is thrown, not blocked), `apps/api/src/llm-gateway/internal-routes.test.ts` and `hooks.test.ts` (`/admit`, `/billing`, `/authorize`).
