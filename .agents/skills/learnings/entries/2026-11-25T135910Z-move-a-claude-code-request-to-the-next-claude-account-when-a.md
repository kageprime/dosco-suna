---
recorded: 2026-11-25T13:59:10Z
incident_date: 2026-11-21
---
# Move a Claude Code request to the next Claude account when Anthropic answers 403, and store Anthropic's reason on the account

**Rule:** In the Claude Code passthrough, a refusal that belongs to one account is never the final answer while another account is left. A `429` rests the account, a `401` marks it for reconnection, and a `403` stores Anthropic's words on the account (`verify_status = invalid`, `verify_message`, `verified_at`). Each of the three moves the request to the next account. The resolver skips a `403` account for 15 minutes, then tries it once more; the next served answer clears it. When no account is left, the gateway and the turn gate both answer with the accounts' names, Anthropic's reason and the fix, never "Connect your Claude subscription". A `403` reports no plan usage. The account list shows the reason in place of the last usage.

**Trigger surface:** Changing `packages/llm-gateway/src/claude-code/passthrough.ts`, the Claude account resolver (`apps/api/src/claude-subscription/accounts.ts`), the turn gate (`projects/claude-subscription/gate.ts`), or the usage write (`recordSubscriptionUsage`).

**Incident:** From 2026-11-21 the factory's Claude workers in the internal company workspace failed with Anthropic's 403 "Your organization has disabled Claude subscription access for Claude Code" on the one account shared with the whole workspace. The gateway relayed the 403 and tried no other account. It marked nothing, so the account list kept showing the last usage as healthy, and the next turn gate said "Connect your Claude subscription".

**Enforcement:** `packages/llm-gateway/src/claude-code/passthrough.test.ts` (a 403 moves on, reports no usage, and asks the host again for the named reason); `apps/api/src/__tests__/integration-claude-accounts.test.ts` (the forbidden account is skipped, named, held 15 min, and cleared by a served answer or a reconnect); `pre-prompt-env-sync.test.ts` (the 409 carries the gate's reason); `@kortix/ui` `subscription-switcher.test.tsx` (Refused by Anthropic).
