/**
 * The connector sign-ins a tool call started.
 *
 * An agent starts a sign-in with `kortix connectors connect <slug>` in its
 * shell, or with the `kortix_connectors` tool's `connect` action. The API
 * records the request on the account row (`requesting_session_id`), and the
 * transcript draws the Connect card for it under the call that started it.
 * This reads which connector, and whose account: `member` (the person's own,
 * the default) or `project` (shared with the workspace), and which of the
 * session's connect requests the call names.
 *
 * Pure data → data, no framework.
 */
import type { SessionConnectRequest } from '../../rest/projects-client/connectors';
import type { ToolCallBlock } from '../../session-log/types';
import { kortixPlatformTool, parseKortixToolResult } from './kortix-tool-card';
import { toolKind } from '../tool-kind';

export interface ConnectorSignInCall {
  /** The connector slug the sign-in is for, as `kortix connectors ls` lists it. */
  slug: string;
  /** Whose account the sign-in makes: the person's own, or the workspace's shared one. */
  owner: 'member' | 'project';
}

/** The `connect` flags that take a value: the token after one is never the slug. */
const VALUE_FLAGS = new Set(['--owner', '--owner-id', '--expires', '--label', '--project', '--workspace']);

const SLUG = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/**
 * `kortix connectors connect` at a command position: the start of the line, or
 * after `;`, `&&`, `||`, `|`, `(` or `$(`, behind optional `VAR=value`
 * assignments and an optional path to the binary. A mention inside an `echo`
 * is not at a command position, so it is no sign-in.
 */
const CONNECT_COMMAND =
  /(?:^|[;\n|(]|&&|\$\()\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(?:[^\s;&|()'"]*\/)?kortix\s+connectors\s+connect(?=\s|$)([^;\n|)]*?)(?=&&|[;\n|)]|$)/g;

function unquote(token: string): string {
  return token.replace(/^(['"])(.*)\1$/, '$2');
}

function ownerOf(value: string | undefined): ConnectorSignInCall['owner'] {
  return value === 'workspace' || value === 'project' ? 'project' : 'member';
}

/** The slug and owner of one `connect` command's arguments, or null without a slug. */
function parseConnectArgs(args: string): ConnectorSignInCall | null {
  const tokens = (args.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map(unquote);
  let slug: string | undefined;
  let owner: string | undefined;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.startsWith('-')) {
      const [flag, inline] = token.split('=', 2) as [string, string | undefined];
      const value = inline ?? (VALUE_FLAGS.has(flag) ? tokens[++i] : undefined);
      if (flag === '--owner') owner = value;
      continue;
    }
    if (slug === undefined && SLUG.test(token)) slug = token;
  }
  return slug ? { slug, owner: ownerOf(owner) } : null;
}

/**
 * The connector sign-ins a call started, in command order: none for any other
 * call. `name` is the call's tool name, `input` its arguments.
 */
export function connectorSignInCalls(name: string, input: unknown): ConnectorSignInCall[] {
  const args = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  if (kortixPlatformTool(name) === 'kortix_connectors') {
    const slug = typeof args.slug === 'string' ? args.slug.trim() : '';
    if (args.action !== 'connect' || !slug) return [];
    const shared = args.shared === true || (args.for_trigger === true && args.shared !== false);
    return [{ slug, owner: shared ? 'project' : 'member' }];
  }
  if (toolKind(name) !== 'bash') return [];
  const command = typeof args.command === 'string' ? args.command : '';
  if (!command.includes('connectors')) return [];
  const calls: ConnectorSignInCall[] = [];
  for (const match of command.matchAll(CONNECT_COMMAND)) {
    const call = parseConnectArgs(match[1] ?? '');
    if (call) calls.push(call);
  }
  return calls;
}

const appKey = (name: string) => name.trim().toLowerCase().replace(/-/g, '_');

/**
 * The session's connect requests (`listSessionConnectRequests`) that a call's
 * sign-ins name, in call order, each once. A sign-in names a request of its
 * connector (the slug, or the provider app behind it) and of the owner it
 * asked for; an older server lists no owner, so then every request of the
 * connector is the call's.
 */
export function connectorSignInRequests<R extends Pick<SessionConnectRequest, 'slug' | 'app' | 'owner_type'>>(
  requests: readonly R[],
  calls: readonly ConnectorSignInCall[],
): R[] {
  const out: R[] = [];
  for (const call of calls) {
    const key = appKey(call.slug);
    const sameApp = requests.filter((request) => appKey(request.slug) === key || appKey(request.app ?? '') === key);
    const owned = sameApp.filter((request) => (request.owner_type ?? 'member') === call.owner);
    for (const request of owned.length > 0 ? owned : sameApp) if (!out.includes(request)) out.push(request);
  }
  return out;
}

/** A shell exit code that says the command failed. */
const exitedNonZero = (exit: unknown): boolean => typeof exit === 'number' && exit !== 0;

/**
 * The connector sign-ins a session-log tool call started: none when the call
 * failed. The status alone does not say it: a failed shell command is
 * `complete` with a non-zero `exit_code` (`normalizeShellExit`), and a refused
 * `kortix_connectors` connect is `complete` with `ok: false`. An agent that
 * retried either drew a second card for the one sign-in.
 */
export function toolCallConnectorSignIns(call: Pick<ToolCallBlock, 'name' | 'input' | 'status' | 'result'>): ConnectorSignInCall[] {
  if (call.status === 'error' || call.result?.is_error || exitedNonZero(call.result?.exit_code)) return [];
  // The `kortix_connectors` tool answers a refusal as a result (`ok: false`), not an error.
  if (call.status === 'complete' && kortixPlatformTool(call.name) === 'kortix_connectors') {
    const text = (call.result?.content ?? []).map((part) => (part.type === 'text' ? part.text : '')).join('');
    if (parseKortixToolResult(text, call.name)?.ok === false) return [];
  }
  return connectorSignInCalls(call.name, call.input);
}

