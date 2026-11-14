/**
 * How many child sessions one session may start in a short window.
 *
 * 2026-11-07: a My Kortix session whose colleagues each refused their task
 * started 149 child sessions in 22 minutes (72 in its busiest 10 minutes),
 * each with its own sandbox. In the 30 days before, the busiest session that
 * worked as meant (the engineering factory) started 30 in 10 minutes. The cap
 * sits between the two. A workflow runner is exempt: its run has its own cap
 * (kortixd `KORTIX_WORKFLOW_MAX_AGENTS`, which the person approves).
 *
 * The refusal is written for the model that called the `agent` tool: it says
 * to stop and tell the person, which is what ends a retry loop.
 */
import { projectSessions } from '@kortix/db';
import { and, count, eq, gt } from 'drizzle-orm';
import { db } from '../../shared/db';
import { sessionIsWorkflowRunner } from './workflow-runner';

const CHILD_SESSION_WINDOW_MS = 10 * 60_000;
export const CHILD_SESSION_LIMIT = 40;

/** Child sessions `parentSessionId` started in this project in the last `windowMs`. */
export async function recentChildSessionCount(
  parentSessionId: string,
  projectId: string,
  windowMs: number = CHILD_SESSION_WINDOW_MS,
): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(projectSessions)
    .where(
      and(
        eq(projectSessions.parentSessionId, parentSessionId),
        eq(projectSessions.projectId, projectId),
        gt(projectSessions.createdAt, new Date(Date.now() - windowMs)),
      ),
    );
  return Number(row?.n ?? 0);
}

/** The 429 for a session over the cap, or null. A workflow runner is never refused here. */
export async function childSessionLimitRefusal(
  callerSessionId: string,
  projectId: string,
): Promise<{ status: 429; body: Record<string, unknown>; headers: Record<string, string> } | null> {
  const started = await recentChildSessionCount(callerSessionId, projectId);
  if (started < CHILD_SESSION_LIMIT) return null;
  if (await sessionIsWorkflowRunner(callerSessionId)) return null;
  const minutes = CHILD_SESSION_WINDOW_MS / 60_000;
  return {
    status: 429,
    body: {
      error: `This session started ${started} sessions in the last ${minutes} minutes, the most one session may start. Stop starting new ones: tell the person what keeps failing and ask how to go on.`,
      code: 'CHILD_SESSION_LIMIT',
      limit: CHILD_SESSION_LIMIT,
      window_seconds: CHILD_SESSION_WINDOW_MS / 1000,
    },
    headers: { 'Retry-After': String(CHILD_SESSION_WINDOW_MS / 1000) },
  };
}
