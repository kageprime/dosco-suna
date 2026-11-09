/**
 * The prompt-body readers the proxy needs before a turn-start body is
 * forwarded, moved out of `pre-prompt-env-sync.ts` (KRTX-4477) so the env-sync
 * module holds exactly one concern. All code and comments below are moved
 * verbatim; every moved name stays re-exported from `pre-prompt-env-sync.ts`,
 * so all existing import paths keep resolving.
 */

// The sentinel name a session carries when it isn't bound to a *concrete* agent.
// `project_sessions.agent_name` defaults to this, and no agent is literally named
// "default" — the runtime resolves it to the manifest's `default_agent`
// (conventionally `kortix`). It is therefore non-binding: a "default" session's
// connector token carries the least-privileged grant (null = full for ungoverned
// projects, deny for governed ones — see `grantFromLoadedAgents`), so a prompt
// can never use it to escalate into another agent's connector / Kortix-CLI grant.
export const DEFAULT_AGENT_SENTINEL = 'default';

/** The body's `agent` field, or null. Pure + exported so it is unit-tested
 *  against a real `/command` body without provisioning a box. */
export function requestedPromptAgent(
  body: ArrayBuffer | undefined,
  incomingHeaders: Headers,
): string | null {
  if (!body) return null;
  const contentType = incomingHeaders.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) return null;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(body)) as {
      agent?: unknown;
    };
    return typeof parsed.agent === 'string' && parsed.agent.trim() ? parsed.agent.trim() : null;
  } catch {
    return null;
  }
}

function stripKortixPrefix(id: string): string {
  return id.startsWith('kortix/') ? id.slice('kortix/'.length) : id;
}

/**
 * The bare managed-model id a turn-start body asks for, or null.
 *
 * NOT ONE WIRE SHAPE — the box's contract differs by endpoint (the
 * `/session/...` shapes are OpenCode's, verified against `@opencode-ai/sdk`'s
 * generated `types.gen.d.ts`; pi serves the same shapes):
 *
 *  - `POST /kortix/runtime/sessions/:id/prompt` — a flat STRING ref
 *    (`"kortix/<id>"`). Every server-relayed delivery arrives as this
 *    (`session-lifecycle/runtime-client.ts`'s `postPrompt`), so it is the
 *    turn-start body the overwhelming majority of prompts have.
 *  - `POST /session/:id/message` and `/prompt_async` (`SessionPromptData`) —
 *    a NESTED `model: {providerID, modelID}`. A daemon without
 *    `runtime.turns.v1` gets the relay in this shape.
 *  - `POST /session/:id/summarize` (`SessionSummarizeData`) — FLAT top-level
 *    `{providerID, modelID}`, no `model` wrapper. `prompt-dedupe.ts` documents
 *    the identical shape for its own reasons.
 *  - `POST /session/:id/command` (`SessionCommandData`) — `model` is a flat
 *    STRING ref (`"kortix/<id>"` or a native `provider/model`), not an object.
 *
 * Only a `kortix`-provider request is in scope: BYOK/other-provider ids are
 * not part of the managed lineup `turn-start-convergence.ts`'s model-catalog
 * lane self-heals, and returning null for them is what makes that lane a
 * no-op (no memo read, no network call) for the overwhelming majority of
 * turns. The result is always the BARE id (the `kortix/` prefix stripped),
 * matching what the control plane's managed lineup and the daemon's own
 * provider map both key on.
 */
export function requestedPromptManagedModelId(
  body: ArrayBuffer | undefined,
  incomingHeaders: Headers,
): string | null {
  if (!body) return null;
  const contentType = incomingHeaders.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) return null;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(body)) as {
      providerID?: unknown;
      modelID?: unknown;
      model?: unknown;
    };
    // `/message` + `/prompt_async`: nested {providerID, modelID}.
    if (parsed.model && typeof parsed.model === 'object' && !Array.isArray(parsed.model)) {
      const nested = parsed.model as { providerID?: unknown; modelID?: unknown };
      if (nested.providerID !== 'kortix') return null;
      const modelID = typeof nested.modelID === 'string' ? nested.modelID.trim() : '';
      return modelID ? stripKortixPrefix(modelID) : null;
    }
    // The Kortix prompt route and `/command`: a flat "kortix/<id>" (or native
    // "provider/model") string.
    if (typeof parsed.model === 'string') {
      const ref = parsed.model.trim();
      return ref.startsWith('kortix/') ? stripKortixPrefix(ref) : null;
    }
    // `/summarize`: flat top-level providerID/modelID, no `model` wrapper.
    if (parsed.providerID === 'kortix') {
      const modelID = typeof parsed.modelID === 'string' ? parsed.modelID.trim() : '';
      return modelID ? stripKortixPrefix(modelID) : null;
    }
    return null;
  } catch {
    return null;
  }
}

// Drop the prompt's `agent` field entirely so the runtime resolves the
// manifest's `default_agent`. Used for non-concrete ('default') sessions: the box must
// always run the agent it booted with — the one the connector token was minted
// for — regardless of which concrete name the client speculatively echoed.
//
// Pure + exported so the rewrite is unit-tested on a real `/command` body — the
// rest of `{command, arguments, variant}` must survive it intact.
export function bodyWithoutPromptAgent(
  body: ArrayBuffer | undefined,
  incomingHeaders: Headers,
): ArrayBuffer | undefined {
  if (!body) return body;
  const contentType = incomingHeaders.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) return body;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(body)) as {
      agent?: unknown;
    };
    if (!('agent' in parsed)) return body;
    parsed.agent = undefined;
    return new TextEncoder().encode(JSON.stringify(parsed)).buffer;
  } catch {
    return body;
  }
}
