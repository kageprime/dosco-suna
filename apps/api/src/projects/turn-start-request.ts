/**
 * "Does this proxied request START a turn?" — the one definition, on a LEAF.
 *
 * It lives apart from `sandbox-deadline-policy.ts` (which re-exports it, so no
 * existing import path changes) for one reason: that module imports
 * `../config`, and `sandbox-proxy/pre-prompt-env-sync.ts` must import NOTHING a
 * proxy suite replaces with `mock.module`. Bun's module registry is
 * PROCESS-wide, so a test file that pulled `config` in through this predicate
 * would cache the real module before a sibling suite could stub it — the exact
 * contamination the pre-prompt-env-sync header documents. This file imports one
 * pure port set and nothing else.
 *
 * `/command` and `/summarize` are in the set because both start a real, billable
 * turn — a classifier admitting only prompt_async/message would kill a box mid
 * command. Callers that want "a USER turn" subtract `/summarize` themselves
 * (`isTurnStartEnvSync`), because compaction carries no prompt and no agent.
 */

import { isOpencodePort } from '../shared/opencode-ports';
import { classifyRuntimeRequest } from '../sandbox-proxy/runtime-request';

/** The in-box agent that reverse-proxies to the runtime. */
const AGENT_PORT = 8000;

/**
 * Does this proxied request START a turn? Used by the proxy to observe a run
 * beginning without trusting anything the sandbox says about itself. The
 * routes are `classifyRuntimeRequest`'s: the daemon's Kortix prompt route and
 * the box's four OpenCode-shaped turn routes, with any `/proxy/<port>` prefix dropped.
 *
 * Either half of the opencode pair counts. A verified reload swaps which one is
 * live, and letting the other through here would let the box's own agent
 * traffic read as a human using a preview — extending the deadline, which is
 * exactly the self-renewal bounded lifetimes exist to prevent.
 */
export function isTurnStartRequest(port: number, method: string, path: string): boolean {
  if (port !== AGENT_PORT && !isOpencodePort(port)) return false;
  return classifyRuntimeRequest(method, path).kind === 'turn-start';
}

/**
 * Should this request get the PRE-PROMPT project-env sync (and the small set of
 * turn-start side effects that hang off it)?
 *
 * ONE PREDICATE, because three turn-start preparations used to disagree inside a
 * single request. `shouldSyncProjectEnvBeforeProxy` — which this replaces —
 * answered `port !== 8000 ⇒ false` and never stripped the in-box `/proxy/<n>/`
 * prefix, while the config-convergence gate and the connector gate both keyed on
 * `isTurnStartRequest`, which covers 4096/4097 AND strips the prefix. Platinum
 * rewrites 4096→8000 and Daytona does not, so on Daytona a prompt addressed
 * straight at :4096 got the config check and the undeclared-agent drop but NOT
 * the secret refresh or the connector-grant re-mint. Same request, two answers,
 * provider-dependent. Built on `isTurnStartRequest` so that can never recur.
 *
 * THREE endpoints. `/command` is one of them, and it was missing until
 * 2026-08-12. `POST /session/:id/command` is the box's blocking slash-command
 * endpoint (OpenCode-shaped, served by pi): it creates a user message and runs a full agent turn, exactly like
 * `/message` does. Skipping the sync for it left two real holes:
 *
 *  - **Stale secrets.** A secret write propagates to live boxes through
 *    `propagateProjectSecretsToActiveSandboxes`, which is fire-and-forget and
 *    targets `status='active'` rows only. A box that was stopped at write time
 *    never receives it, so the per-turn sync is the ONLY self-heal. A session
 *    driven entirely by slash commands never healed.
 *  - **An unre-scoped agent switch.** A command body carries `agent` just like a
 *    prompt does. `agentSwitchRefusal` decides whether the caller MAY run that
 *    agent, but only this block re-resolves the secret grant for it
 *    (`syncSandboxEnvForPrompt`'s `requestedAgent`) and re-points the session
 *    token's connector/CLI grant at it (`remintGrantForAgentSwitch`). Without
 *    both, `/command` with `agent: B` ran B against agent A's env and A's grant.
 *
 * It is deliberately NOT the same list as `isNonIdempotentSessionWrite`, and the
 * two must not be merged back together — see the comment on that function. This
 * one answers "does this turn need its env re-scoped first?"; that one answers
 * "may the proxy send this body twice?".
 *
 * `/summarize` stays OUT even though `isTurnStartRequest` counts it. Compaction
 * carries no user prompt and no `agent` to re-scope for, and the sync is
 * fail-closed on a grant error — refusing to compact a conversation because a
 * manifest read failed would wedge a session instead of protecting it. That is
 * the ONLY difference from `isTurnStartRequest`, and it is why the connector
 * gate (`isConnectorGatedTurn`, which excluded `/summarize` for the identical
 * reason) is now this same function rather than a second copy of it.
 *
 * CALL IT WITH THE UPSTREAM PORT and the remaining path — the values the request
 * actually reaches the box on. Passing the client-addressed port is what created
 * the divergence above.
 *
 * Pure + exported so the gate is unit-tested without provisioning a box — the
 * same reason `shouldAutoResumeStoppedSandbox` and `isProxiedBaseReset` are.
 */
export function isTurnStartEnvSync(port: number, method: string, path: string): boolean {
  if (!isTurnStartRequest(port, method, path)) return false;
  const request = classifyRuntimeRequest(method, path);
  return request.kind === 'turn-start' && request.verb !== 'summarize';
}
