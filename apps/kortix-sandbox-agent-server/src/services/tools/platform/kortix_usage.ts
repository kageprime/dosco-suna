/**
 * kortix_usage: how many credits this project's work used, and on which
 * sessions. Amounts are in credits, the unit people see in Kortix; never quote
 * a price. A My Kortix platform tool (`platform.ts`): `kortix billing costs`.
 */
import { capRows, cliJson, fail, ok, projectId, sessionHref, type PlatformToolContext } from './platform'

const TOOL = 'kortix_usage' as const
const ACTIONS = ['summary', 'top_sessions'] as const

/** One workspace's row of `kortix billing costs --by workspace --json`. */
interface WorkspaceCost {
  credits?: { total?: string; llm?: string; compute?: string }
}

interface SessionCost {
  session_id?: string
  title?: string | null
  name?: string | null
  agent_name?: string | null
  total_cost?: number
}

/** `--since` for the last `days` days, UTC. */
function since(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString()
}

function windowDays(value: unknown): number {
  const days = typeof value === 'number' ? Math.round(value) : 30
  return Math.min(Math.max(days, 1), 90)
}

/**
 * This workspace's credits in [now - days, now) and in the window before it. The per-workspace
 * roll-up sums each window once; the account summary (`billing costs` without `--by`) also
 * builds a daily series and a model breakdown this card never shows, which on a busy workspace
 * ran past the API's 25 s deadline (KRTX-4877).
 */
async function summary(days: number, context: PlatformToolContext) {
  const now = Date.now()
  const span = days * 86_400_000
  const window = (from: number, to: number) =>
    cliJson<{ projects?: WorkspaceCost[] }>(
      ['billing', 'costs', '--by', 'workspace', '--project', projectId(context.env), '--since', new Date(from).toISOString(), '--until', new Date(to).toISOString(), '--json'],
      context,
    )
  const [current, before] = await Promise.all([window(now - span, now), window(now - 2 * span, now - span)])
  if ('error' in current) return fail(TOOL, 'summary', 'Could not read the usage', current.error, context)
  if ('error' in before) return fail(TOOL, 'summary', 'Could not read the usage', before.error, context)
  // No row: the workspace used nothing in that window.
  const c = current.value.projects?.[0]?.credits ?? {}
  const previous = before.value.projects?.[0]?.credits?.total ?? '0'
  return ok(
    TOOL,
    'summary',
    {
      title: `${c.total ?? '0'} credits in the last ${days} days`,
      subtitle: `${previous} credits in the ${days} days before.`,
      rows: [
        ...(c.llm && c.llm !== '—' ? [{ title: 'AI models', detail: `${c.llm} credits` }] : []),
        ...(c.compute && c.compute !== '—' ? [{ title: 'Computers', detail: `${c.compute} credits` }] : []),
      ],
    },
    { days, credits: { ...c, previous } },
  )
}

async function topSessions(days: number, context: PlatformToolContext) {
  const read = await cliJson<{ sessions?: SessionCost[] }>(
    ['billing', 'costs', '--by', 'session', '--project', projectId(context.env), '--since', since(days), '--limit', '8', '--json'],
    context,
  )
  if ('error' in read) return fail(TOOL, 'top_sessions', 'Could not read the usage', read.error, context)
  const sessions = read.value.sessions ?? []
  return ok(
    TOOL,
    'top_sessions',
    {
      title: `The sessions that used the most, last ${days} days`,
      rows: capRows(
        sessions.map((row) => ({
          title: row.title || row.name || `Session ${(row.session_id ?? '').slice(0, 8)}`,
          ...(row.agent_name ? { detail: row.agent_name } : {}),
          ...(row.session_id ? { href: sessionHref(context.env, row.session_id) } : {}),
        })),
      ),
    },
    read.value,
  )
}

export default {
  description:
    "How many credits this project's work used. Actions: `summary` (days, default 30: the total, split into AI models and computers); " +
    '`top_sessions` (days: the sessions that used the most). Speak in credits; never quote a price.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: [...ACTIONS], description: 'What to read.' },
      days: { type: 'number', description: 'The window, 1-90 days. Default 30.' },
    },
    required: ['action'],
  },
  async execute(args: Record<string, any>, context: PlatformToolContext) {
    const action = String(args.action ?? '')
    const days = windowDays(args.days)
    if (action === 'summary') return summary(days, context)
    if (action === 'top_sessions') return topSessions(days, context)
    return fail(TOOL, action, 'Unknown action', { kind: 'invalid', message: `Use one of: ${ACTIONS.join(', ')}.` }, context)
  },
}
