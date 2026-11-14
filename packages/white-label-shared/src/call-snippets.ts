/**
 * The call-snippet model both white-label apps render (their developer panel,
 * `./call-snippet.tsx`): the HTTP form, the snippet shape, the renderer, and
 * the two calls both apps document. Each app keeps its own catalog in
 * `src/lib/call-snippets.ts`: its ids, its placeholder bearer, its own calls,
 * and the one note per shared call that names how that app keeps one caller
 * out of another's data.
 */

/** Rendered wherever a real secret value would otherwise go. */
export const SECRET_VALUE_PLACEHOLDER = '$SECRET_VALUE';

/** Stand-ins for ids a screen may not have yet (the create dialog runs before
 *  any session exists). */
export const PLACEHOLDER = {
  projectId: '{projectId}',
  sessionId: '{sessionId}',
  executionId: '{executionId}',
  identifier: '{identifier}',
  envKey: '{ENV_KEY}',
  model: 'anthropic/claude-sonnet-4-5',
  projectName: 'Acme workspace',
} as const;

/**
 * The HTTP form. `runtime` is not a REST call at all — a prompt goes to the
 * session's own runtime through the authenticated session proxy, whose URL the
 * SDK owns and client code is forbidden to build (`scripts/sdk-boundary.mjs`).
 * Printing a path there would teach hand-rolling the one thing the SDK exists
 * to hold.
 */
type HttpForm =
  | {
      kind: 'rest';
      method: string;
      path: string;
      /** Request headers beyond authorization. */
      headers?: string[];
      body?: unknown;
    }
  | { kind: 'runtime'; summary: string };

export interface CallSnippet {
  id: string;
  /** Names the action as the UI names it, not as the route names it. */
  title: string;
  /** One line: what this call is for. */
  summary: string;
  /** The `@kortix/sdk` call this app makes. */
  sdk: string;
  http: HttpForm;
  /** Fields or headers the application server adds. */
  serverInjected: string[];
  /** The things the two forms above would otherwise imply wrongly. */
  notes: string[];
}

export function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/**
 * One copy-pasteable request block.
 *
 * The authorization line is part of the block on purpose: the single most
 * common wrapper mistake is forwarding the end user's own token upstream, and
 * seeing the placeholder bearer on every call is the correction.
 */
export function renderHttp(form: HttpForm, authorization: string): string {
  if (form.kind === 'runtime') return form.summary;
  const lines = [`${form.method} ${form.path}`, authorization, ...(form.headers ?? [])];
  if (form.body === undefined) return lines.join('\n');
  lines.push('Content-Type: application/json', '', json(form.body));
  return lines.join('\n');
}

/** True when the HTTP form is a request someone can copy and run. */
export function isCopyableHttp(form: HttpForm): boolean {
  return form.kind === 'rest';
}

// ── The calls both apps make ─────────────────────────────────────────────────

/** `ownership`: how this app keeps one caller out of another's session. */
export function sessionDelete(
  ctx: { projectId?: string; sessionId?: string },
  ownership: string,
): CallSnippet {
  const projectId = ctx.projectId ?? PLACEHOLDER.projectId;
  const sessionId = ctx.sessionId ?? PLACEHOLDER.sessionId;

  return {
    id: 'session.delete',
    title: 'Restart or delete a session',
    summary: 'The two ways a session ends — one keeps the sandbox, one destroys it.',
    sdk: [
      '// Reboots the runtime, keeps the session and its sandbox identity.',
      'await kortix.session(projectId, sessionId).restart();',
      '',
      '// Destroys the session and the sandbox behind it. Not recoverable.',
      'await kortix.session(projectId, sessionId).delete();',
    ].join('\n'),
    http: {
      kind: 'rest',
      method: 'DELETE',
      path: `/v1/projects/${projectId}/sessions/${sessionId}`,
    },
    serverInjected: [],
    notes: [
      `Restart is a separate call — \`POST /v1/projects/${projectId}/sessions/${sessionId}/restart\`. It keeps the sandbox, so a session that came up wrong recovers without losing its transcript, but it still ends whatever turn was in flight.`,
      "Both calls clear the SDK's cached runtime for these ids first (`forgetReady()`), so no later handle can resolve a sandbox that has been replaced or destroyed.",
      ownership,
      'Deleting is not a refund. The session cost record remains available after the runtime is destroyed.',
    ],
  };
}

/** `inbox`: why this app reads pending approvals from the session audit. */
export function approvalResolve(
  ctx: { projectId?: string; executionId?: string },
  inbox: string,
): CallSnippet {
  const projectId = ctx.projectId ?? PLACEHOLDER.projectId;
  const executionId = ctx.executionId ?? PLACEHOLDER.executionId;
  return {
    id: 'approval.resolve',
    title: 'Resolve an approval',
    summary: 'A `require_approval` gate ends the agent’s turn until a person decides.',
    sdk: `await kortix.project(projectId).approvals.resolve('${executionId}', 'approve');`,
    http: {
      kind: 'rest',
      method: 'POST',
      path: `/v1/projects/${projectId}/approvals/${executionId}`,
      body: { decision: 'approve' },
    },
    serverInjected: [],
    notes: [
      'A decision covers exactly the call that asked for it. The `session` / `session_all` scopes were removed: a grant keyed on (session, connector, action) ignores the ARGUMENTS, so approving a send to one recipient silently pre-authorised a send to any other. To run a tool unattended, author an `always_run` policy rule instead.',
      inbox,
      'Some refusals cannot be retried with the same credential at all; they need a decision from a signed-in person. A wrapper has no personal upstream identity, which is also why a connector call denied `connector_not_connected` for a member-owned account can never be resolved by this credential — only a teammate connecting their own account, or the project sharing one, fixes it.',
    ],
  };
}
