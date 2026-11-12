/**
 * Everything that must happen BEFORE a turn-start body reaches the runtime, split
 * out of `routes/preview.ts` so it can be imported WITHOUT evaluating the route.
 *
 * That split is load-bearing, not cosmetic. `routes/preview.ts` binds its
 * collaborators (`../projects/lib/sandbox-env-sync`, `session-token-grant`,
 * `../../config`, `../backend`, `../../iam`, …) at
 * module-evaluation time, and every sibling proxy suite replaces exactly those
 * modules with `mock.module` before importing the route. Bun's module registry
 * is PROCESS-wide and a module evaluates once: any test file that imports
 * `routes/preview.ts` at top level caches the route with its REAL collaborators,
 * and every suite that runs after it in the same process silently gets the real
 * ones too — its `mock.module` stubs never take effect and its assertions stop
 * being able to fail. Measured: `preview-connector-required.test.ts` alone is
 * 13 pass / 0 fail; run after a file that imported the route it was 27 / 3, and
 * the three casualties were the Idempotency-Key-burn cases.
 *
 * Since KRTX-4477 this file holds only the env sync itself: the refusal
 * response (`jsonProxyError`, `errorMessage`) lives in `proxy-error.ts`, the
 * body readers (`DEFAULT_AGENT_SENTINEL`, `requestedPromptAgent`,
 * `requestedPromptManagedModelId`, `bodyWithoutPromptAgent`) in
 * `prompt-body.ts`, and `isTurnStartEnvSync` beside the `isTurnStartRequest`
 * it is phrased on, in `projects/turn-start-request.ts` (the repo lint rule
 * `kortix-api/projects-surface` bars a deep `projects/` import from a new
 * proxy module, so `proxy-path.ts` cannot host it). All three are re-exported
 * from here, so every existing import path keeps resolving. The module still
 * imports NOTHING that a proxy suite mocks as a value:
 *  - the four collaborators are `import type` only (erased at runtime) and are
 *    passed in as `PrePromptEnvSyncDeps` — the real set lives in
 *    `forward/turn-start.ts`;
 *  - `secret-grant`, `session-token-grant` (the error classes) and
 *    `session-title-generate` (`extractPromptInfo`) are imported for real, and
 *    no proxy suite mocks any of them.
 *
 * `routes/preview.ts` re-exports the public names, so every existing import
 * path keeps working.
 */
import { claudeSubscriptionRequiredBody } from '../llm-gateway/resolution/claude-agent';
import type { ProviderName } from '../platform/providers';
import type { bindSessionTurnIdentity } from '../projects/lib/on-behalf-of';
import type { syncSandboxEnvForPrompt } from '../projects/lib/sandbox-env-sync';
import { SecretGrantResolutionError } from '../projects/lib/secret-grant';
import {
  SessionGrantRemintError,
  type remintGrantForAgentSwitch,
} from '../projects/lib/session-token-grant';
import {
  extractPromptInfo,
  type generateSessionTitleFromFirstPrompt,
} from '../projects/session-title-generate';
import { errorMessage, jsonProxyError } from './proxy-error';
import { DEFAULT_AGENT_SENTINEL } from './prompt-body';

// Re-exported so every importer keeps resolving through this path after the
// KRTX-4477 split. `isTurnStartEnvSync` is defined in
// `projects/turn-start-request.ts`, beside the `isTurnStartRequest` it is phrased
// on (the repo lint rule `kortix-api/projects-surface` bars a deep import from a
// new proxy module; this edge is this file's already-listed one).
export { errorMessage, jsonProxyError } from './proxy-error';
export {
  DEFAULT_AGENT_SENTINEL,
  bodyWithoutPromptAgent,
  requestedPromptAgent,
  requestedPromptManagedModelId,
} from './prompt-body';
export { isTurnStartEnvSync } from '../projects/turn-start-request';

// A fetch that timed out or never connected (Bun and Node spellings).
const RETRYABLE_ENV_SYNC_ERROR_NAMES = new Set(['TimeoutError', 'AbortError']);
const RETRYABLE_ENV_SYNC_ERROR_CODES = new Set([
  'ConnectionRefused',
  'ConnectionClosed',
  'FailedToOpenSocket',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
]);

export function isRetryableEnvSyncFailure(err: unknown): boolean {
  const e = err as { name?: unknown; code?: unknown; status?: unknown } | null | undefined;
  // `EnvSyncHttpError` (projects/lib/sandbox-env-push.ts), matched by name so
  // this module does not import the push module's DB graph.
  if (e?.name === 'EnvSyncHttpError') return e.status === 502 || e.status === 503 || e.status === 504;
  return RETRYABLE_ENV_SYNC_ERROR_NAMES.has(String(e?.name)) || RETRYABLE_ENV_SYNC_ERROR_CODES.has(String(e?.code));
}

/**
 * One warn per minute per process for a refused prompt (KRTX-4016).
 *
 * A container-wide fork burst (`spawn EAGAIN` / `cannot fork() for
 * remote-https`) refuses EVERY prompt for minutes, and the per-prompt warn
 * became the log-pattern spike the issue files on — 52 identical lines in one
 * 4-minute window, against a 4-line-per-hour baseline. The refusal response is
 * unchanged (still 503 + `git_mirror_unavailable`, retryable); only the log
 * dedupes, and the aggregate count keeps the burst measurable in one line.
 *
 * Emission is traffic-driven: the suppressed count covers everything since the
 * previous line, whatever span that was, and flushes on the next refusal.
 * ponytail: the final suppressed count flushes on the next refusal only; a
 * wall-clock flush needs a module timer per burst — add one if the aggregate
 * must be exact.
 */
const GRANT_REFUSAL_LOG_INTERVAL_MS = 60_000;
let grantRefusalLastLoggedAt = 0;
let grantRefusalsSinceLog = 0;

export function logSecretGrantRefusal(
  sandboxId: string,
  port: number,
  detail: string,
  now = Date.now(),
): void {
  grantRefusalsSinceLog += 1;
  if (now - grantRefusalLastLoggedAt < GRANT_REFUSAL_LOG_INTERVAL_MS) return;
  const suppressed = grantRefusalsSinceLog - 1;
  grantRefusalLastLoggedAt = now;
  grantRefusalsSinceLog = 0;
  console.warn(
    `[PREVIEW] Secret grant refused prompt for ${sandboxId}:${port}: ${detail}` +
      (suppressed > 0 ? ` (+${suppressed} suppressed since the previous line)` : ''),
  );
}

/** Test-only: forget the refusal log rate-limit state. */
export function __resetSecretGrantRefusalLogForTests(): void {
  grantRefusalLastLoggedAt = 0;
  grantRefusalsSinceLog = 0;
}

/**
 * Map a secret-grant failure from the pre-prompt env sync onto its response, or
 * null when the error is an ordinary env-sync failure the caller should handle
 * with its existing retry/502 logic.
 *
 * Every case refuses the prompt rather than forwarding it: the sandbox's env is
 * provisioned for ONE agent's grant, so a prompt we can't prove is entitled to
 * that env must not reach the runtime. See projects/lib/secret-grant.ts.
 */
export function secretGrantErrorResponse(err: unknown, origin?: string): Response | null {
  // A prompt naming a different agent is never refused — it is re-scoped.
  // The one 409: the prompt runs My Kortix in a project whose kortix.yaml
  // turned it off. Every other case is "we could not APPLY the re-scope", a
  // 503 the client should retry, not a conflict the user must resolve.
  //
  // We could not establish what this agent may read. 503 rather than 502: the
  // sandbox is fine, our ability to VERIFY entitlement is what failed, and
  // retrying is the correct client response.
  // The switch was legal but we could not rewrite the token's grant to match the
  // agent now running. 503 for the same reason as above — and refusing is the
  // point: forwarding would run the new agent against the OLD agent's connector
  // and CLI grants, which is exactly the escalation the re-mint closes.
  if (err instanceof SessionGrantRemintError && err.code === 'builtin_agent_disabled') {
    const error = err.cause instanceof Error ? err.cause.message : err.message;
    return jsonProxyError({ error, code: 'builtin_agent_disabled' }, 409, origin);
  }
  if (err instanceof SessionGrantRemintError) {
    return jsonProxyError(
      { error: err.message, code: 'AGENT_SWITCH_GRANT_UNAPPLIED' },
      503,
      origin,
    );
  }
  if (err instanceof SecretGrantResolutionError) {
    return jsonProxyError(
      { error: err.message, code: 'AGENT_SECRET_GRANT_UNRESOLVED' },
      503,
      origin,
    );
  }
  return null;
}

/**
 * The collaborators `runPrePromptEnvSync` calls, injectable so the block can be
 * tested with plain fakes.
 *
 * DI rather than `mock.module`, deliberately: bun's `mock.module` is PROCESS-wide
 * and does not unwind at file boundaries, so a proxy test that stubbed `../backend`
 * silently blanked the real module for every sibling suite that ran after it in
 * the same process (4 unrelated proxy test
 * cases went red with `Received: 0` — their spies never fired). Passing the
 * collaborators in keeps the seam local to one call.
 *
 * There is deliberately NO default value: a default would have to name the four
 * real modules here, and evaluating this file would then cache them before a
 * sibling suite's `mock.module` could replace them — the very contamination the
 * split exists to prevent. The REAL set is built in `forward/turn-start.ts`, which
 * every sibling re-evaluates under its own mocks.
 *
 * `extractPromptInfo` is deliberately NOT here. Whether a body yields prompt text
 * is the decision under test — a `/command` body has no `parts`, so it yields
 * none — and injecting it would test the fake instead of the rule.
 */
export interface PrePromptEnvSyncDeps {
  syncEnv: typeof syncSandboxEnvForPrompt;
  remintGrant: typeof remintGrantForAgentSwitch;
  bindTurnIdentity: typeof bindSessionTurnIdentity;
  generateTitle: typeof generateSessionTitleFromFirstPrompt;
  /**
   * The Claude subscription model ref this turn needs a login for that the
   * person lacks, or null. `promptModel` null: the session's own model.
   */
  claudeSubscriptionMissing?: (input: {
    accountId: string;
    projectId: string;
    sessionId: string;
    userId: string;
    promptModel: string | null;
  }) => Promise<string | null>;
}

/**
 * Everything that must happen BEFORE a turn-start body reaches the runtime.
 *
 * Returns `null` to proceed with the forward, or the Response that REFUSES the
 * turn. A transient/retryable env-sync failure THROWS instead, so the caller's
 * wake-and-retry loop treats it exactly like any other sandbox reachability miss
 * — that control flow is load-bearing and unchanged by this extraction.
 *
 * Runs for `/prompt_async`, `/message` AND `/command` (see
 * `isTurnStartEnvSync`). The caller has already applied the
 * 'default'-sentinel body rewrite, so `body` here is what will be forwarded.
 */
export async function runPrePromptEnvSync(
  input: {
    record: {
      accountId: string;
      projectId: string;
      sessionId: string;
      externalId: string;
      agentName?: string | null;
      provider: string;
    };
    sandboxId: string;
    port: number;
    userId: string;
    origin: string;
    previewUrl: string;
    providerHeaders: Record<string, string>;
    serviceKey: string | null;
    /** The body's `agent`, read BEFORE the sentinel rewrite. */
    requestedAgent: string | null;
    /** `userId` is the person who started this turn directly through the proxy
     *  (not the queue, which binds in `continueSession`, and not the sandbox's
     *  own token): the session token acts as them from this turn on. */
    bindTurnIdentity: boolean;
    body: ArrayBuffer | undefined;
    incomingHeaders: Headers;
  },
  deps: PrePromptEnvSyncDeps,
): Promise<Response | null> {
  const { record, sandboxId, port, userId, origin, requestedAgent } = input;
  const sessionAgent = record.agentName ?? DEFAULT_AGENT_SENTINEL;
  // A prompt is the one moment this sandbox is guaranteed awake, so off it we
  // (1) generate the Kortix-owned session title from this first prompt, using
  // the model the user picked, and (2) refresh the runtime_sessions snapshot
  // the conversation list reads. Both are fire-and-forget and never block the
  // prompt.
  //
  // A `/command` body is `{command, arguments, agent, model, variant}` and
  // carries no `parts`, so `extractPromptInfo` finds no text and the title is
  // SKIPPED — deliberately, not by accident. Titling a session
  // "/webapp build a site" would name it after the invocation rather than the
  // request, and feeding a raw command to the title model costs a completion for
  // a poor name. The snapshot refresh below still runs: a
  // command creates messages exactly like a prompt, so the conversation list is
  // just as stale after it.
  const prompt = extractPromptInfo(input.body, input.incomingHeaders);
  // A Claude subscription model runs on the prompting person's own Claude
  // login. Without one the box could only fail the turn, so it is refused
  // here, before any title or env work, with a code clients turn into a
  // Connect button.
  if (deps.claudeSubscriptionMissing && input.bindTurnIdentity && userId) {
    const missing = await deps.claudeSubscriptionMissing({
      accountId: record.accountId,
      projectId: record.projectId,
      sessionId: record.sessionId,
      userId,
      promptModel: prompt.model,
    });
    if (missing) return jsonProxyError(claudeSubscriptionRequiredBody(missing), 409, origin);
  }
  if (userId && prompt.text) {
    void deps.generateTitle({
      sessionId: record.sessionId,
      projectId: record.projectId,
      accountId: record.accountId,
      userId,
      firstPromptText: prompt.text,
      modelHint: prompt.model ?? undefined,
    });
  }
  try {
    // NOT R2 material, on purpose — `command-env-sync.test.ts` ("Refused
    // BEFORE the grant re-mint — one switch never half-applies") pins this:
    // `remintGrant` re-points the session token's connector/CLI grant, a real
    // DB mutation, and it must never even START when `syncEnv` (which pushes
    // THIS agent's secret grant to the box) has failed — applying the grant
    // re-mint for an agent whose env was never actually established on the
    // sandbox is exactly the half-applied switch this ordering exists to
    // prevent. A first pass at this file ran the two concurrently as a
    // latency win; the invariant test caught it (`remintGrant` fired even
    // though `syncEnv` threw) and it was reverted. Sequential is correct
    // here, not merely unoptimized.
    // The turn-identity bind lands BEFORE the env push: the push reads the
    // person the session token acts for, and a change of person must never
    // ride its trusted fast path with the previous person's personal secrets
    // (sandbox-env-push.ts). A failed bind refuses the turn like a failed grant
    // re-mint: no turn runs as the previous prompter.
    if (input.bindTurnIdentity && userId) {
      const bindFailed = await deps
        .bindTurnIdentity({ accountId: record.accountId, sessionId: record.sessionId, prompterUserId: userId })
        .then(
          () => false,
          (err) => {
            // The cause stays in the log; the client gets no SQL text.
            console.warn(`[PREVIEW] Turn identity bind failed for ${sandboxId}: ${errorMessage(err, 'bind failed')}`);
            return true;
          },
        );
      if (bindFailed) {
        return jsonProxyError({ error: 'could not bind the session to the person starting this turn' }, 502, origin);
      }
    }
    await deps.syncEnv({
      projectId: record.projectId,
      sessionId: record.sessionId,
      externalId: record.externalId,
      serviceKey: input.serviceKey,
      previewUrl: input.previewUrl,
      providerHeaders: input.providerHeaders,
      providerName: record.provider as ProviderName,
      // The secret grant is resolved from the agent this prompt actually runs,
      // not the session's create-time column — see projects/lib/secret-grant.ts.
      requestedAgent,
    });
    // The env sync above applied the running agent's secret grant, or refused it
    // when the optional strict lock is enabled. Re-point the token's
    // connector/CLI grant at the agent that will actually run — it was frozen at
    // mint from the BOOT agent, and the CLI/API gates read it straight from
    // the token row at call time. Synchronous, same-agent case included: a
    // manifest that narrowed the grant in the previous turn must be enforced
    // from the first call of this one (see `remintGrantForAgentSwitch`).
    await deps.remintGrant({
      projectId: record.projectId,
      sessionId: record.sessionId,
      sessionAgent,
      requestedAgent,
    });
  } catch (err) {
    // Fail closed on anything to do with the secret grant: refuse the prompt
    // rather than forwarding it against an env we can't vouch for.
    const grantResponse = secretGrantErrorResponse(err, origin);
    if (grantResponse) {
      logSecretGrantRefusal(sandboxId, port, errorMessage(err, 'secret grant error'));
      return grantResponse;
    }
    const message = errorMessage(err, 'project env sync failed');
    if (isRetryableEnvSyncFailure(err)) {
      // Treat daemon/preview-transient env-sync failures like any other
      // sandbox-port reachability miss: retry/wake in the outer loop, then
      // return the friendly port-unreachable response if the sandbox never
      // recovers. Throwing HTTPException here bypassed that retry path and
      // turned expected 502/timeouts from Daytona into Better Stack errors.
      throw new Error(message);
    }
    console.warn(`[PREVIEW] Project env sync failed for ${sandboxId}:${port}: ${message}`);
    // The body stays stable and termless: an internal failure's own message
    // can name stack-level context, already logged server-side.
    return jsonProxyError({ error: 'Project env sync failed. Retry the request or check the sandbox logs.' }, 502, origin);
  }
  return null;
}
