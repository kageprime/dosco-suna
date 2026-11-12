/**
 * A person decides the access My Kortix asked for a colleague
 * (colleague-access.ts). The route already proved the caller is a person who
 * may decide this session's asks (`mayResolveApproval`). This adds the one
 * rule of its own: a member allows only what an enabled agent already holds;
 * a project manager allows anything. Then one decision, and My Kortix hears it
 * as a new message in the session that asked.
 */
import { logger } from '../../lib/logger';
import { loadProjectAgents } from '../agents';
import type { GitBackedProject } from '../git';
import { deliverThroughQueue } from '../session-lifecycle';
import {
  type ColleagueAccessAsk,
  type ColleagueAccessDecision,
  decideColleagueAccessAsk,
  itemsNoAgentHolds,
  renderColleagueAccessDecision,
} from './colleague-access';

export type ColleagueAccessAnswer = { status: 200 | 403 | 409; body: Record<string, unknown> };

export async function answerColleagueAccessAsk(input: {
  ask: ColleagueAccessAsk;
  decision: ColleagueAccessDecision;
  decidedBy: string;
  isManager: boolean;
  project: GitBackedProject;
}): Promise<ColleagueAccessAnswer> {
  const { ask, decision } = input;
  if (decision === 'allow' && !input.isManager) {
    const agents = await loadProjectAgents(input.project, { forceRefresh: 'tip-proof', rethrowReadErrors: true });
    const notHeld = itemsNoAgentHolds(agents, ask);
    if (notHeld.length) {
      return {
        status: 403,
        body: {
          error: `No agent of this workspace has ${notHeld.join(', ')}. Only a workspace manager can allow it.`,
          code: 'COLLEAGUE_ACCESS_NEEDS_MANAGER',
          items: notHeld,
        },
      };
    }
  }
  const decided = await decideColleagueAccessAsk({ id: ask.id, decision, decidedBy: input.decidedBy });
  if (!decided) return { status: 409, body: { error: 'This ask was already decided', code: 'ALREADY_DECIDED' } };
  const text = renderColleagueAccessDecision(ask, decision);
  const outcome = await deliverThroughQueue(
    {
      source: 'ui',
      idempotencyKey: `access:${ask.id}`,
      sessionId: ask.sessionId,
      text,
      // Harness context, not the person's words: the transcript draws it as the decision.
      parts: [{ type: 'text', text, synthetic: true }],
      userId: input.decidedBy,
    },
    { wait: false },
  ).catch((err: unknown) => {
    logger.warn('[asks] colleague access decision not delivered', {
      sessionId: ask.sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return 'failed' as const;
  });
  return { status: 200, body: { ok: outcome === 'delivered' || outcome === 'queued', delivery: outcome } };
}
