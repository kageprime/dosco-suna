/**
 * The API call behind every Kortix action this app performs (the developer
 * panel, `src/components/dev/call-snippet.tsx`; off unless NEXT_PUBLIC_LUMEN_DEV_PANELS=1).
 *
 * A reference wrapper's real job is to teach what to call, and a screenshot of a
 * dialog teaches nothing. So each action carries the two forms a wrapper author
 * actually arrives with:
 *
 *  - SDK — the `@kortix/sdk` call this app runs, verbatim.
 *  - HTTP — the request that ends up on the wire, for anyone integrating from a
 *    language with no SDK.
 *
 * Two rules this module exists to keep:
 *
 * 1. NOTHING SECRET IS EVER RENDERED. No secret value, no API key, no bearer
 *    token — the authorization header is always the `$KORTIX_MEMBER_TOKEN`
 *    placeholder and a secret's value is always `SECRET_VALUE_PLACEHOLDER`.
 *    That is why `SnippetContext` accepts a secret's IDENTIFIER and env KEY and
 *    has nowhere to put a value: a demo that teaches people to paste their key
 *    into a screenshot is worse than no demo.
 * 2. THE HTTP FORM MATCHES THE SDK CALL. The wrapper adds authorization only.
 *    Product data remains in the request body or query shown by the snippet.
 *
 * The building is pure and lives here rather than in the panel so what the demo
 * claims it sends can be asserted without rendering anything.
 */

import {
  type CallSnippet,
  approvalResolve,
  sessionDelete,
} from '@kortix/white-label-shared/call-snippets';

/**
 * The upstream bearer, as a placeholder: the member's project-scoped token
 * that the proxy swaps in. Never a real key.
 */
export const AUTHORIZATION_HEADER = 'Authorization: Bearer $KORTIX_MEMBER_TOKEN';

/**
 * Every Kortix action this app performs, in the order a wrapper author meets
 * them: provision a project, see what may be bound to a session, start one,
 * talk to it, read what it cost, end it, and manage the secrets behind it.
 *
 * An action the app performs with no id here is an action whose call the demo
 * hides — `tests/unit/call-snippets-coverage.test.ts` reads the app's own source
 * to make that a test failure rather than an omission nobody notices.
 */
export const CALL_SNIPPET_IDS = [
  'session.delete',
  'approval.resolve',
] as const;

export type CallSnippetId = (typeof CALL_SNIPPET_IDS)[number];

export interface SnippetContext {
  projectId?: string;
  sessionId?: string;
  /** The agent a prompt would name, when one is picked. */
  agent?: string | null;
  executionId?: string;
  /** The project name a provision would send, when the field is filled in. */
  projectName?: string;
  /**
   * A secret's addressable parts. There is deliberately NO `value` field: this
   * type is the boundary that keeps secret material out of every snippet.
   */
  secret?: { identifier?: string; name?: string };
}

// ── The calls ────────────────────────────────────────────────────────────────

// `connector.connect-link` (kortix.project().setupLinks.requestConnector())
// was removed with `ConnectRequiredCard`: the create-time connector pre-flight
// it minted a remedy link for can no longer occur (`require_connectors` is
// inert), so the button it backed had nothing left to be a remedy for. The
// call-time gate's remedy is `connect_url` on the `connector_not_connected`
// denial, surfaced by the transcript's `SetupLinkButton` — not a snippet here.

const BUILDERS: Record<CallSnippetId, (ctx: SnippetContext) => CallSnippet> = {
  'session.delete': (ctx) =>
    sessionDelete(
      ctx,
      "Every firm shares one Kortix project. The firm's service account reaches only the sessions it created (Kortix keeps a session private to its creator), and the proxy accepts only a session that is a thread of the bearer's matter, so one firm cannot end another's session.",
    ),
  'approval.resolve': (ctx) =>
    approvalResolve(
      ctx,
      'The pending set is read from the per-SESSION audit, not the project-wide approval inbox: every member of the workspace shares one project, so the inbox would hand this browser execution ids from other members’ threads, and an execution id is all this route needs.',
    ),
};

/** One action's snippet, filled in with whatever the screen actually knows. */
export function callSnippet(id: CallSnippetId, ctx: SnippetContext = {}): CallSnippet {
  return BUILDERS[id](ctx);
}

/** Every snippet, in the order a wrapper author meets them. */
export function callSnippets(ctx: SnippetContext = {}): CallSnippet[] {
  return CALL_SNIPPET_IDS.map((id) => callSnippet(id, ctx));
}
