/**
 * `kortix sessions usage <session-id>` — what a session and every session it
 * started cost and consumed, from the gateway request ledger
 * (`GET /workspaces/:id/sessions/:sessionId/usage`). A thin client: the API
 * walks the session tree (root first, then descendants depth-first) and sums
 * it; this prints it, or passes it through verbatim with `--json`.
 *
 * Honesty: paid Kortix wallet spend (`kortix_cost`) and BYOK provider spend
 * (`provider_cost`) are separate numbers; `cost` is their sum. A request on a
 * subscription plan (ChatGPT/Claude) is neither: it counts in tokens and
 * requests, not dollars, and is never shown as paid spend. Every number is the
 * ledger's; nothing is derived from the transcript (reasoning, last-reply
 * context), which is not historical ledger data.
 */
import { emitJson, locateSessionAnywhere, surfaceApiError } from '../command-helpers.ts';
import { C, help, money, pad, status } from '../style.ts';
import { terminalSafe } from '../token-denial.ts';
import { parseCommon } from './sessions-lifecycle.ts';

const USAGE_HELP = help`Usage: kortix sessions usage <session-id> [options]

What a session and every session it started cost and consumed, from the
gateway request ledger: the session first, then its descendants (up to 10
levels and 500 sessions the caller may open).

Per session: PAID WALLET (debited from the Kortix wallet), BYOK PROVIDER
(paid to your own provider key) and TOTAL; requests and errors; input,
output, cached and cache-write tokens. Subscription-plan requests count in
tokens only and are never paid spend.

Options:
  --workspace <id>  Operate on this workspace id (default: linked).
  --host <name>     Operate against a non-default Kortix host.
  --json            The API's usage tree, verbatim.
  -h, --help        Show this help.
`;

interface UsageTotals {
  cost: number;
  kortix_cost: number;
  provider_cost: number;
  request_count: number;
  error_count: number;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  cache_write_tokens: number;
}

interface UsageNode extends UsageTotals {
  session_id: string;
  parent_session_id: string | null;
  depth: number;
  title: string | null;
  agent_name: string | null;
  status: string;
}

interface UsageTree {
  session_id: string;
  currency: 'USD';
  total: UsageTotals;
  sessions: UsageNode[];
  hidden_sessions: number;
  truncated: boolean;
}

const num = (n: number) => Number(n ?? 0).toLocaleString('en-US');

export async function runSessionsUsage(argv: string[]): Promise<number> {
  const parsed = parseCommon(argv, USAGE_HELP);
  if (typeof parsed === 'number') return parsed;
  const { rest, opts, json } = parsed;

  const sessionId = rest.filter((a) => !a.startsWith('-'))[0];
  if (!sessionId) {
    process.stderr.write(`${status.err('Pass a session id.')}\n\n${USAGE_HELP}`);
    return 2;
  }
  const located = await locateSessionAnywhere(
    sessionId,
    opts,
    (host) => `kortix sessions usage ${sessionId} --host ${host}`,
  );
  if (!located) return 1;
  const { client, projectId, session } = located.located;

  let tree: UsageTree;
  try {
    tree = await client.get<UsageTree>(
      `/workspaces/${projectId}/sessions/${session.session_id}/usage`,
    );
  } catch (err) {
    return surfaceApiError(err);
  }

  if (json) {
    emitJson(tree);
    return 0;
  }

  const t = tree.total;
  const out: string[] = [
    '',
    `  ${C.bold}${tree.sessions.length} session${tree.sessions.length === 1 ? '' : 's'}${C.reset}  ${num(t.request_count)} req · ${num(t.error_count)} err`,
    `  PAID WALLET ${money(t.kortix_cost)}  ·  BYOK PROVIDER ${money(t.provider_cost)}  ·  TOTAL ${money(t.cost)}`,
    `  ${C.dim}tokens in/out/cached/write: ${num(t.input_tokens)}/${num(t.output_tokens)}/${num(t.cached_tokens)}/${num(t.cache_write_tokens)}${C.reset}`,
    `  ${C.dim}Subscription-plan requests count in tokens only, never as paid spend.${C.reset}`,
    '',
  ];
  for (const s of tree.sessions) {
    // A title and an agent name are set by workspace members: never let one
    // move the cursor or recolor the row (and so forge the figures beside it).
    const label = `${'  '.repeat(s.depth)}${terminalSafe(s.title ?? s.session_id.slice(0, 8))}`;
    out.push(
      `  ${pad(label, 40)} ${money(s.cost).padStart(10)}  ` +
        `${C.dim}paid ${money(s.kortix_cost)} · byok ${money(s.provider_cost)} · ${num(s.request_count)} req · ${num(s.error_count)} err · ` +
        `${num(s.input_tokens)}/${num(s.output_tokens)} tok · cached ${num(s.cached_tokens)} · cache-write ${num(s.cache_write_tokens)} · ${terminalSafe(s.agent_name ?? 'unknown')}${C.reset}`,
    );
  }
  if (tree.hidden_sessions > 0) {
    out.push(
      `\n  ${C.dim}${tree.hidden_sessions} descendant session(s) you may not open are not counted.${C.reset}`,
    );
  }
  if (tree.truncated) {
    out.push(
      `  ${C.yellow}The walk stopped at its limit (10 levels / 500 sessions): totals are partial.${C.reset}`,
    );
  }
  process.stdout.write(`${out.join('\n')}\n\n`);
  return 0;
}
