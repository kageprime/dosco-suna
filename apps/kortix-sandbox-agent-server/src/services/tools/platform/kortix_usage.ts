/**
 * kortix_usage: how many credits this project's work used, on which sessions,
 * and how many are left. Amounts are in credits, the unit people see in Kortix;
 * never quote a price. A My Kortix platform tool (`platform.ts`):
 * `kortix billing costs` and `kortix billing status`.
 */
import { capRows, cliJson, fail, ok, projectId, sessionHref, type PlatformToolContext } from './platform'

const TOOL = 'kortix_usage' as const
const ACTIONS = ['summary', 'top_sessions', 'balance'] as const

/** One workspace's row of `kortix billing costs --by workspace --json`. */
interface WorkspaceCost {
  credits?: { total?: string; llm?: string; compute?: string }
}

/** One row of `kortix billing costs --by session --json`. */
interface SessionCost {
  session_id?: string
  owner_name?: string | null
  project_name?: string | null
  credits?: { total?: string; llm?: string; compute?: string }
  [field: string]: unknown
}

/** The credits part of `kortix billing status --json`. */
interface BillingStatus {
  plan?: { label?: string | null }
  credits?: { total?: number; monthly?: number; extra?: number; expires_at?: string | null; can_run?: boolean }
}

const whole = (value: number) => Math.floor(value).toLocaleString('en-US')

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
          title: `Session ${(row.session_id ?? '').slice(0, 8)}`,
          ...(row.owner_name ? { detail: `Started by ${row.owner_name}` } : {}),
          ...(row.credits?.total ? { badge: `${row.credits.total} credits` } : {}),
          ...(row.session_id ? { href: sessionHref(context.env, row.session_id) } : {}),
        })),
      ),
    },
    // Credits only: the `*_cost` fields are prices, and the model must never quote one.
    { days, sessions: sessions.map((row) => ({ session_id: row.session_id ?? null, owner: row.owner_name ?? null, credits: row.credits ?? null })) },
  )
}

/**
 * The credits left now and the plan. Usage shows only what was spent, so a promise to
 * watch for a top-up or a low balance needs this (QualiLoop Core 9: two such promises
 * built on `summary`).
 */
async function balance(context: PlatformToolContext) {
  const read = await cliJson<BillingStatus>(['billing', 'status', '--json'], context)
  if ('error' in read) return fail(TOOL, 'balance', 'Could not read the balance', read.error, context)
  const c = read.value.credits ?? {}
  const total = typeof c.total === 'number' ? c.total : null
  const expires = c.expires_at ? new Date(c.expires_at).toISOString().slice(0, 10) : null
  return ok(
    TOOL,
    'balance',
    {
      title: total === null ? 'Balance unknown' : `${whole(total)} credits left`,
      ...(read.value.plan?.label ? { subtitle: `${read.value.plan.label} plan.` } : {}),
      rows: [
        ...(typeof c.monthly === 'number' ? [{ title: 'This month\'s credits', detail: `${whole(c.monthly)} credits${expires ? `, until ${expires}` : ''}` }] : []),
        ...(typeof c.extra === 'number' ? [{ title: 'Extra credits', detail: `${whole(c.extra)} credits` }] : []),
        ...(c.can_run === false ? [{ title: 'Work is paused', detail: 'No credits left to run agents.' }] : []),
      ],
    },
    { credits: total, monthly: c.monthly ?? null, extra: c.extra ?? null, expires_at: c.expires_at ?? null, can_run: c.can_run ?? null, plan: read.value.plan?.label ?? null },
  )
}

export default {
  description:
    "How many credits this project's work used. Actions: `summary` (days, default 30: the total, split into AI models and computers); " +
    '`top_sessions` (days: the sessions that used the most); `balance` (the credits left now and the plan: read it to check a top-up or a low balance, which usage cannot show). Speak in credits; never quote a price.',
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
    if (action === 'balance') return balance(context)
    return fail(TOOL, action, 'Unknown action', { kind: 'invalid', message: `Use one of: ${ACTIONS.join(', ')}.` }, context)
  },
}
