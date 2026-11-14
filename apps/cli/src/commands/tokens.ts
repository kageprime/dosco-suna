import { ApiError } from '../api/client.ts';
import { splitHelp } from '../command-argv.ts';
import {
  emitJson,
  fail,
  missing,
  resolveAccountContext,
  resolveSpanInstant,
  surfaceApiError,
  takeFlagBool,
  takeFlagValue,
} from '../command-helpers.ts';
import { iamBase } from '../iam.ts';
import { confirm } from '../prompts.ts';
import { C, help, pad, scopeLabel, status } from '../style.ts';

import { connectedApps } from './tokens-apps.ts';
import { serviceAccounts } from './tokens-service-accounts.ts';
// `kortix tokens` — the account's non-interactive credentials. This module
// holds the personal API keys (`/accounts/tokens`) — they act as YOU and are
// revoked automatically when you leave the account — and routes the account's
// other two credentials to their own modules: `tokens-service-accounts.ts`
// (service accounts, act as THEMSELVES) and `tokens-apps.ts` (connected
// OAuth apps).
//
// Note `kortix token` (singular) is a different, unrelated command: it prints
// the ACTIVE token's context (`whoami --token-only`).

/**
 * Resolve `--expires` to the ISO-8601 instant the API stores.
 *
 * Accepts an ISO timestamp or a FORWARD span (`30d`, `12h`, `6w`, `1y`) —
 * "expires in 30 days" is what anyone minting a key actually means, and the
 * API only speaks ISO. Resolved here so `--json` shows the instant really sent.
 */
export function resolveExpiry(input: string, now: Date = new Date()): string | null {
  return resolveSpanInstant(input, now, 1);
}

interface AccountToken {
  token_id: string;
  name: string;
  project_id: string | null;
  public_key: string;
  status: string;
  expires_at: string | null;
  last_used_at?: string | null;
  created_at: string;
  revoked_at?: string | null;
  secret_key?: string;
  /** What the key may do inside its creator's role. Absent on older APIs (= full). */
  scope?: 'full' | 'read' | 'custom';
  workspace_permissions?: string[] | null;
  /** True for the CLI login: each use moves the expiry out again. */
  expiry_renews?: boolean;
}

/**
 * Parse `--scope`: `full`, `read`, or a comma-separated list of permissions
 * (either spelling, e.g. `workspace.session.read,workspace.session.start`).
 * Null for an empty value.
 */
export function parseScopeFlag(input: string): 'full' | 'read' | string[] | null {
  const value = input.trim();
  if (value === 'full' || value === 'read') return value;
  const list = value.split(',').map((p) => p.trim()).filter(Boolean);
  return list.length > 0 ? list : null;
}

/** The EXPIRES column of a key row. */
function expiryLabel(t: AccountToken): string {
  if (!t.expires_at) return 'never';
  return t.expiry_renews ? `${t.expires_at.slice(0, 10)} (renews on use)` : t.expires_at.slice(0, 10);
}

const HELP = help`Usage: kortix tokens <subcommand> [options]

A key that acts as you, an agent or a bot: \`kortix keys\`.

Non-interactive credentials for this workspace. Reads need token.read. Every
member may mint and revoke their OWN personal keys (token.personal.create,
token.personal.revoke). Service accounts and other people's keys need
token.create / token.revoke.

Personal API keys — act as YOU, and die with your membership:
  ls [--mine] [--all] [--json]      List the workspace's keys that still
                                    authenticate. --mine narrows to the ones
                                    you minted yourself; --mine --all lists
                                    your revoked keys too.
  new <name> [--expires <when>]     Mint a key. The secret prints ONCE.
      [--scope read|full|<list>]    Default expiry: 90 days; at most 365.
      [--workspace <id>]            Bind the key to one workspace (it can never
                                    reach another).
  rm <token-id> [-y] [--force]      Revoke a key; delete it if already revoked.
                                    Refuses the key this CLI is signed in
                                    with unless --force.

Service accounts — act as THEMSELVES, with no inherited access:
  service-accounts ls [--json]              List service accounts.
  service-accounts new <name>               Create one. The bearer prints ONCE.
      [--description <t>] [--expires <when>]
  service-accounts disable <id>             Disable the service account (it
                                            cannot authorize; delete and
                                            re-create to return).
  service-accounts rm <id> [-y]             Delete permanently.

Connected apps — apps you approved with "Sign in with Kortix" (MCP clients
such as Claude Code or Cursor). Yours, across every account:
  apps ls [--json]                  List them.
  apps rm <client-id> [-y]          Revoke one: its tokens stop working at
                                    once, and it must ask you again.

A new service account holds NO permissions. Grant it one with
\`kortix access grant --service-account <id> --role <key>\`.

Options:
  --mine              ls: only the keys you minted.
  --all               ls --mine: also list your keys that cannot
                      authenticate (revoked, or revoked_at stamped on a row
                      still reading active). Without --mine it changes
                      nothing: the workspace list holds live keys only.
  --expires <when>    ISO-8601, a forward span (30d, 12h, 6w, 1y), or
                      never (only where the workspace key policy allows it).
                      Omitted: 90 days.
  --scope <s>         new: what the key may do inside your role. full (the
                      default), read (every *.read permission; GET only), or a
                      comma-separated permission list. A scoped key is a
                      workspace key of the selected workspace.
  --workspace <id>    new: bind the key to one workspace.
  --description <t>   service-accounts new: what this identity is for.
  --host <name>       Operate against a non-default Kortix host.
  --json              Machine-readable output. List rows of both kinds
                      carry a shared \`id\`.
  -y, --yes           Skip the confirmation prompt.
  -h, --help          Show this help.

Examples:
  kortix tokens ls --mine
  kortix tokens new ci-deploy --expires 90d
  kortix tokens new dashboard --scope read --expires 30d
  kortix tokens new runner --scope workspace.session.read,workspace.session.start
  kortix tokens new laptop --project 1a2b… --expires 2027-01-01
  kortix tokens apps ls
  kortix tokens service-accounts new nightly-reporter --description "Cron"
  kortix access grant --service-account <id> --role member --project 1a2b…
`;

export async function runTokens(argv: string[]): Promise<number> {
  const helpCode = splitHelp(argv, HELP);
  if (helpCode !== null) return helpCode;

  const sub = argv[0];
  const rest = argv.slice(1);
  const f: Record<string, string | undefined> = {};
  let json = false;
  let mine = false;
  let all = false;
  let yes = false;
  let force = false;
  try {
    f.account = takeFlagValue(rest, ['--account']);
    f.host = takeFlagValue(rest, ['--host']);
    f.expires = takeFlagValue(rest, ['--expires']);
    f.scope = takeFlagValue(rest, ['--scope', '--scopes']);
    f.project = takeFlagValue(rest, ['--project', '--workspace']);
    f.description = takeFlagValue(rest, ['--description', '--desc']);
    json = takeFlagBool(rest, ['--json']);
    mine = takeFlagBool(rest, ['--mine']);
    all = takeFlagBool(rest, ['--all']);
    yes = takeFlagBool(rest, ['-y', '--yes']);
    force = takeFlagBool(rest, ['--force']);
  } catch (err) {
    return fail((err as Error).message);
  }
  const positional = rest.filter((a) => !a.startsWith('-'));

  let expiresAt: string | null | undefined;
  if (f.expires !== undefined && f.expires.trim() === 'never') {
    expiresAt = null;
  } else if (f.expires !== undefined) {
    const iso = resolveExpiry(f.expires);
    if (!iso)
      return fail(
        `--expires "${f.expires}" is not an ISO-8601 instant or a span like 30d/12h/6w/1y.`,
      );
    expiresAt = iso;
  }

  const ctx = resolveAccountContext({
    workspaceArg: f.project,
    accountArg: f.account,
    hostArg: f.host,
    accountOptional: sub === 'apps',
  });
  if (!ctx) return 1;
  const saBase = `${iamBase(ctx.accountId)}/service-accounts`;

  try {
    switch (sub) {
      case 'ls':
      case 'list': {
        // The client already appends `?account_id=`; `mine` narrows to the
        // caller's own hand-minted keys (no session or connector tokens).
        const tokens = await ctx.client.get<AccountToken[]>(
          `/accounts/tokens${mine ? '?mine=true' : ''}`,
        );
        // `?mine=true` keeps dead keys as history — the settings page renders
        // them muted — but a CLI list means "keys that still authenticate":
        // status='active' AND revoked_at null, the server's own live predicate
        // (listAccountTokens / validateAccountToken / isRevokedRow in
        // apps/api/src/repositories/account-tokens.ts; the two columns are not
        // tied by any DB constraint, so both halves are needed). `--all` brings
        // the history back.
        const visible =
          mine && !all
            ? tokens.filter((t) => t.status === 'active' && !t.revoked_at)
            : tokens;
        const hidden = tokens.length - visible.length;
        if (json) {
          // `id` is the key every token kind shares (KRTX-2829); `token_id` stays.
          emitJson(visible.map((t) => ({ id: t.token_id, ...t })));
          return 0;
        }
        if (visible.length === 0) {
          process.stdout.write(
            `\n  ${C.dim}No API keys${mine ? ' minted by you' : ''}. Mint one with ` +
              `${C.reset}${C.cyan}kortix tokens new <name>${C.reset}\n`,
          );
          if (hidden > 0) {
            process.stdout.write(
              `  ${C.dim}${hidden} revoked key${hidden === 1 ? '' : 's'} hidden — list them with ` +
                `${C.reset}${C.cyan}kortix tokens ls --mine --all${C.reset}\n`,
            );
          }
          process.stdout.write('\n');
          return 0;
        }
        const nameW = Math.max(...visible.map((t) => t.name.length), 4);
        const keyW = Math.max(...visible.map((t) => t.public_key.length), 6);
        process.stdout.write('\n');
        process.stdout.write(
          `  ${C.dim}${pad('NAME', nameW)}   ${pad('PUBLIC KEY', keyW)}   ${pad('STATUS', 7)}   ${pad('SCOPE', 10)}   ${pad('EXPIRES', 10)}   TOKEN ID${C.reset}\n`,
        );
        for (const t of visible) {
          const state = t.status === 'active' ? t.status : `${C.yellow}${t.status}${C.reset}`;
          process.stdout.write(
            `  ${pad(t.name, nameW)}   ${pad(t.public_key, keyW)}   ${pad(state, 7)}   ${pad(scopeLabel(t), 10)}   ` +
              `${pad(expiryLabel(t), 10)}   ${C.faded}${t.token_id}${C.reset}\n`,
          );
        }
        const count =
          hidden > 0
            ? `${visible.length} key${visible.length === 1 ? '' : 's'} · ${hidden} revoked hidden (--mine --all lists them)`
            : `${visible.length} key${visible.length === 1 ? '' : 's'}`;
        process.stdout.write(`\n  ${C.dim}${count}${C.reset}\n\n`);
        return 0;
      }

      case 'new':
      case 'create': {
        const name = positional[0];
        if (!name) return missing('a key name');
        const scopes = f.scope !== undefined ? parseScopeFlag(f.scope) : undefined;
        if (scopes === null) return fail('--scope needs full, read, or a comma-separated list of permissions.');
        // A scoped key is a workspace key: it mints under the workspace. Without
        // --scope the older route keeps its meaning (a personal key unless
        // --workspace binds it). account_id rides in the BODY there: that route
        // resolves the account from the body, not the query string.
        const token = scopes !== undefined
          ? await ctx.client.post<AccountToken>(`/workspaces/${encodeURIComponent(f.project ?? ctx.accountId)}/tokens`, {
              name,
              scopes,
              ...(expiresAt !== undefined ? { expires_at: expiresAt } : {}),
            })
          : await ctx.client.post<AccountToken>('/accounts/tokens', {
              name,
              account_id: ctx.accountId,
              ...(expiresAt !== undefined ? { expires_at: expiresAt } : {}),
              ...(f.project ? { project_id: f.project } : {}),
            });
        if (json) {
          emitJson(token);
          return 0;
        }
        process.stdout.write(`${status.ok(`Minted ${C.bold}${token.name}${C.reset}`)}\n\n`);
        process.stdout.write(`  ${token.secret_key ?? '(no secret returned)'}\n\n`);
        process.stdout.write(
          `${status.warn('This is the only time the secret is shown. Store it now.')}\n`,
        );
        process.stdout.write(`  ${C.dim}token_id ${C.reset}${token.token_id}\n`);
        process.stdout.write(`  ${C.dim}expires  ${C.reset}${expiryLabel(token)}\n`);
        process.stdout.write(`  ${C.dim}scope    ${C.reset}${scopeLabel(token)}\n`);
        if (token.project_id) {
          process.stdout.write(`  ${C.dim}workspace  ${C.reset}${token.project_id}\n`);
        }
        return 0;
      }

      case 'apps':
        return await connectedApps(ctx.client, positional, { json, yes });

      case 'rm':
      case 'revoke':
      case 'delete':
        return await revokeToken(ctx.client, positional, { yes, force });

      case 'service-accounts':
      case 'sa':
        return await serviceAccounts(ctx.client, saBase, positional, {
          json,
          yes,
          expiresAt: expiresAt ?? undefined,
          description: f.description,
        });

      default:
        process.stderr.write(`${status.err(`unknown subcommand "${sub}"`)}\n\n${HELP}`);
        return 2;
    }
  } catch (err) {
    return surfaceApiError(err);
  }
}

/** `kortix tokens rm` — revoke a key, or delete an already-revoked personal key. */
async function revokeToken(
  client: NonNullable<ReturnType<typeof resolveAccountContext>>['client'],
  positional: string[],
  opts: { yes: boolean; force: boolean },
): Promise<number> {
  const tokenId = positional[0];
  if (!tokenId) return missing('a token id (see `kortix tokens ls`)');
  // Revoking the key this CLI signs in with locks the host out: every next
  // command answers "token rejected" (KRTX-1842). `/accounts/me` names the
  // calling token; a failed probe never blocks the revoke.
  if (!opts.force) {
    const me = await client
      .get<{ token_context?: { token_id?: string | null } }>('/me')
      .catch(() => null);
    if (me?.token_context?.token_id === tokenId) {
      process.stderr.write(
        `${status.err(`${tokenId} is the key this CLI is signed in with.`)} Revoking it signs this host out. ` +
          `Sign in with another key first (${C.cyan}kortix login${C.reset}), or pass ${C.cyan}--force${C.reset} to revoke it anyway.\n`,
      );
      return 2;
    }
  }
  if (!opts.yes) {
    const ok = await confirm(
      `Revoke API key ${C.bold}${tokenId}${C.reset}, or permanently delete it if already revoked?`,
      false,
      { onEndOfInput: false },
    );
    if (!ok) {
      process.stdout.write(`${C.dim}Cancelled.${C.reset}\n`);
      return 0;
    }
  }
  const tokens = await client.get<AccountToken[]>('/accounts/tokens?mine=true');
  const token = tokens.find((row) => row.token_id === tokenId);
  const query = token?.status === 'revoked' ? '?delete_revoked=true' : '';
  let deleted = false;
  try {
    const result = await client.delete<{ deleted?: boolean }>(
      `/accounts/tokens/${encodeURIComponent(tokenId)}${query}`,
    );
    deleted = result.deleted === true;
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 404 || !token) throw error;
    // A lost response can replay a completed operation. Verify its intended
    // result without issuing a second, different mutation.
    const remaining = await client.get<AccountToken[]>('/accounts/tokens?mine=true');
    const current = remaining.find((row) => row.token_id === tokenId);
    deleted = token.status === 'revoked';
    if (deleted ? current !== undefined : current?.status !== 'revoked') throw error;
  }
  process.stdout.write(`${status.ok(`${deleted ? 'Deleted' : 'Revoked'} ${C.bold}${tokenId}${C.reset}`)}\n`);
  return 0;
}
