import type { HeroRun } from './hero-runs';

/**
 * Example sessions for the hero reel. Each one is a loop that fired on its
 * own: `ask` is the event as it arrived (the alert, the webhook, the job's
 * name), never an instruction someone typed. Only a Slack message keeps a
 * person's words, because a person wrote it. All are labelled examples: the
 * steps each loop runs, with made-up inputs. Most are engineering loops; the
 * few others close the reel.
 */
type Session = Pick<HeroRun, 'caption' | 'source' | 'via' | 'ask' | 'context' | 'work' | 'answer' | 'rows' | 'result'>;

/** The engineer's sessions, by the id its panel takes. */
const ENGINEER: Record<string, Session> = {
  sentry: {
    caption: 'Fixes what breaks',
    source: 'Sentry · new issue',
    via: 'sentry',
    ask: 'TypeError: Cannot read properties of undefined (reading "total") · 412 events',
    context: 'checkout-service',
    work: [{ text: 'Pulled the stack trace' }, { text: 'git log -p src/cart.ts', cmd: true }, { text: 'Wrote a failing test' }, { text: 'Guarded the empty cart' }],
    answer: 'An empty cart had no totals. Added the guard and a test that fails on main.',
    result: { kind: 'Pull request #212 · +14 −2', title: 'fix: handle an empty cart at checkout', status: 'Waiting for you to merge' },
  },
  slack: {
    caption: 'Takes requests in Slack',
    source: 'Slack · #eng',
    via: 'slack',
    ask: '@engineer CSV export times out for big workspaces. Can you take it?',
    context: '#eng thread',
    work: [{ text: 'Reproduced it with 200k rows' }, { text: 'EXPLAIN the export query', cmd: true }, { text: 'Added the missing index' }, { text: 'Streamed the file instead of buffering it' }],
    answer: 'The export scanned the whole table. With the index and a stream it finishes in 3 s. Replied in the thread.',
    result: { kind: 'Pull request #231 · +38 −12', title: 'fix: stream CSV exports and index workspace_id', status: 'Waiting for you to merge' },
  },
  ci: {
    caption: 'Bisects a red main',
    source: 'GitHub Actions · main',
    via: 'githubactions',
    ask: 'CI failed on main · test (node 22) · 3 commits since the last green run',
    context: 'main @ 9c4e1f2',
    work: [{ text: 'Read the failing job log' }, { text: 'git bisect run npm test', cmd: true }, { text: 'Found the commit: a3f9c21' }, { text: 'Fixed the date parsing it broke' }],
    answer: 'a3f9c21 parsed dates in the server time zone. The fix pins UTC, and main is green on the branch.',
    result: { kind: 'Pull request #327 · +9 −4', title: 'fix: parse invoice dates as UTC', status: 'Waiting for you to merge' },
  },
  deploy: {
    caption: 'Rolls back a bad deploy',
    source: 'Vercel · production',
    via: 'vercel',
    ask: 'Deployment failed · health check timed out · v2.14.0',
    context: 'production',
    work: [{ text: 'Read the deploy log' }, { text: 'Rolled back to v2.13.2' }, { text: 'Compared the env of both releases' }, { text: 'Posted the cause in #eng' }],
    answer: 'Rolled back in 40 s. v2.14.0 reads REDIS_URL, which production does not set.',
    rows: [
      { label: 'rollback', text: 'v2.13.2 serving, 0 errors', done: true },
      { label: 'cause', text: 'REDIS_URL missing in production' },
    ],
  },
  renovate: {
    caption: 'Keeps dependencies current',
    source: 'Pull request #318 opened',
    via: 'github',
    ask: 'Renovate: update dependency next to v16.0.3',
    context: 'renovate/next-16.x',
    work: [{ text: 'Read the release notes' }, { text: 'npm run build', cmd: true }, { text: 'npm test', cmd: true }, { text: 'Applied the one codemod it needs' }],
    answer: 'One breaking change touched this app. The codemod fixed it, and every check passes.',
    rows: [
      { label: 'build', text: 'passed in 52 s', done: true },
      { label: 'tests', text: '418 pass, 0 fail', done: true },
      { label: 'types', text: '0 errors', done: true },
    ],
  },
  cve: {
    caption: 'Patches vulnerabilities',
    source: 'Security advisory',
    via: 'github',
    ask: 'High severity · path traversal in archive-utils < 3.2.1',
    context: 'package-lock.json',
    work: [{ text: 'Found it in 2 services' }, { text: 'Upgraded to 3.2.1' }, { text: 'npm test', cmd: true }],
    answer: 'Both services now use the fixed version, and every test passes.',
    result: { kind: 'Pull request #320 · +6 −6', title: 'chore: upgrade archive-utils to 3.2.1', status: 'Waiting for you to merge' },
  },
  latency: {
    caption: 'Catches regressions',
    source: 'PagerDuty',
    via: 'pagerduty',
    ask: 'p95 latency 840 ms on /api/orders · since deploy v2.14.1',
    context: 'api-production',
    work: [{ text: 'Compared traces before and after the deploy' }, { text: 'Found one query per order line' }, { text: 'Batched it into one query' }, { text: 'Load-tested the branch' }],
    answer: 'v2.14.1 loaded each order line on its own. One batched query brings p95 back to 120 ms.',
    result: { kind: 'Pull request #324 · +21 −17', title: 'perf: load order lines in one query', status: 'Waiting for you to merge' },
  },
  migration: {
    caption: 'Dry-runs every migration',
    source: 'Pull request #322 opened',
    via: 'github',
    ask: 'migrations/0042_orders_status.sql added',
    context: 'feat/order-status',
    work: [{ text: "Restored last night's backup to a scratch database" }, { text: 'Ran the migration and timed it' }, { text: 'Rewrote the index as CONCURRENTLY' }],
    answer: 'As written it locks orders for 38 s. The rewrite takes no lock. A suggestion is on the pull request.',
    rows: [
      { label: 'before', text: 'locks orders for 38 s' },
      { label: 'after', text: 'no lock, 41 s', done: true },
    ],
  },
};

/** The sessions of the other agents, which close the reel. */
const OTHERS: Record<string, Session> = {
  finance: {
    caption: 'Files every invoice',
    source: 'Schedule · 1st of the month',
    via: 'schedule',
    ask: 'monthly-invoices · November',
    context: '15 vendor accounts',
    work: [{ text: 'Signed in to 15 vendor accounts' }, { text: 'Downloaded each invoice' }, { text: 'Filed them in accounting' }],
    answer: '14 invoices filed in accounting. One account needs your login.',
    rows: [
      { label: '$4,212', text: 'AWS', done: true },
      { label: '$1,176', text: 'GitHub', done: true },
      { label: '$864', text: 'Google Workspace', done: true },
      { label: '$640', text: 'Vercel', done: true },
      { label: '—', text: 'Figma: sign in once' },
    ],
  },
};

function toRun(slug: string, id: string, session: Session): HeroRun {
  return { id, kind: 'example', host: { kind: 'agent', slug, name: slug }, ...session };
}

/** The engineer's sessions that open the reel, before the setup: an alert and a Slack message, runs nobody typed. */
export function leadRuns(agent: string): [HeroRun, HeroRun] {
  return [toRun(agent, 'sentry', ENGINEER.sentry!), toRun(agent, 'slack', ENGINEER.slack!)];
}

/** The engineering loops after the demo run, one panel each. */
export function engineeringRuns(agent: string): HeroRun[] {
  return (['ci', 'deploy', 'renovate', 'cve', 'latency', 'migration'] as const).map((id) => toRun(agent, id, ENGINEER[id]!));
}

/** The other teams' loops at the end of the reel. */
export function closingRuns(): HeroRun[] {
  return [toRun('finance', 'finance', OTHERS.finance!)];
}

/** Every session a panel can play: each panel replays its own session. */
export function sessionPool(run: HeroRun): HeroRun[] {
  return [run];
}
