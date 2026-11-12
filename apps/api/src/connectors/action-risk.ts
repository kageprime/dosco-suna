/**
 * The risk the gateway enforces for one connector action.
 *
 * Composio and Pipedream send no per-action risk annotation, so their
 * normalizer stored `write` for every action, so `GMAIL_LIST_LABELS` needed write
 * approval and a read-only rule set blocked it. For those two sources the
 * reviewed classifier (`classifyUnannotatedToolRisk`) decides: a read verb with
 * no write word in the name or the description is `read`, anything else stays
 * `write`. Every other source carries its own risk (an HTTP method, a GraphQL
 * operation, MCP annotations, a native catalog), and that stored risk stands.
 *
 * The read sites apply this to stored rows too, so a catalog synced before the
 * rule is gated the same way without a re-sync.
 */
import { classifyUnannotatedToolRisk } from '@kortix/shared/tool-risk';
import type { Risk } from './types';

/** Sources whose stored `write` is a fallback, not a fact about the action. */
const UNANNOTATED_PROVIDERS = new Set(['composio', 'pipedream']);

export function unannotatedActionRisk(
  provider: string,
  action: { path: string; description?: string | null; risk: Risk; bindingKind?: string | null },
): Risk {
  if (action.risk !== 'write' || !UNANNOTATED_PROVIDERS.has(provider)) return action.risk;
  // The Connect Proxy reaches any endpoint with any method.
  if (action.bindingKind === 'pipedream_proxy') return 'write';
  return classifyUnannotatedToolRisk(action.path, action.description ?? '');
}
