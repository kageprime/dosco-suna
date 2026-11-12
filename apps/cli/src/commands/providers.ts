import { CATALOG, isProviderAuthSatisfied, primaryAuthEnvVars } from '@kortix/llm-catalog';
import { type AccountSecretResource, connectionAccessSummary, probeEffectivePermission, providerKeyAccessFields } from '@kortix/sdk';
import { formatRelative } from '@kortix/shared';

import type { Auth } from '../api/auth.ts';
import { type ApiClient, ApiError, withCliErrors } from '../api/client.ts';
import type {
  CustomLlmProvider,
  OauthFlowStartResponse,
  OauthListResponse,
  OauthPollResponse,
  ProjectSecret,
} from '../api/types.ts';
import { openInBrowser } from '../browser.ts';
import { rejectUnknownArgs, splitHelp } from '../command-argv.ts';
import {
  emitJson,
  fail,
  missing,
  query,
  resolveAccountContext,
  resolveProjectContext,
  surfaceApiError,
  takeFlagBool,
  takeFlagValue,
  takeFlagValues,
} from '../command-helpers.ts';
import { resolveProjectId } from '../project-link.ts';
import { EndOfInputError, readSecret, readVisible } from '../prompts.ts';
import { C, help, pad, status } from '../style.ts';
import { sleep } from '@kortix/shared/guards';

const HELP = help`Usage: kortix providers <subcommand> [options]

Configure LLM providers for the linked Kortix workspace. Three paths:

  • OAuth (zero config) — uses the upstream provider's device-code flow
    (ChatGPT Pro/Plus, an OpenCode Console account for OpenCode Zen or Go).
    Tokens land encrypted on the workspace; Kortix refreshes them.

  • API key — stored encrypted as a provider key of the workspace, listed
    in the web under Models → Providers. Shared with everyone in this
    workspace by default; --private keeps it to you. The Kortix LLM
    gateway uses it; the key never enters a sandbox.

  • Custom endpoint — any OpenAI-compatible API (vLLM, LiteLLM, Ollama
    behind a public host). The gateway serves its models as <id>/<model>.

Subcommands:
  ls [--json]                       List configured providers: OAuth, the
                                    provider keys under Models → Providers
                                    (label, who can use each) and API-key
                                    workspace secrets that map to known
                                    providers.
  ls --catalog [--search <query>]    Browse the bundled provider catalog,
                                    filtered by id or name. --json supported.
                                    env lists workspace secrets to configure
                                    with \`kortix secrets set NAME=value\`.
  login <provider>                  Run the OAuth device-code flow.
                                    Providers: openai, opencode (Zen),
                                    opencode-go. Zen and Go each need
                                    their own login.
  set <provider> [<key>] [--label <label>] [--private]
                                    Save an API key as a provider key under
                                    Models → Providers. It is shared with
                                    everyone in this workspace; --private
                                    keeps it to you. --label names it
                                    (default "<Provider> key"). Your key
                                    with the same label gets the new value
                                    and keeps its access. Kortix checks
                                    the key with one small request to the
                                    provider and says if it was refused;
                                    a refused key stays saved.
                                    Provider → env-var mapping below.
                                    With no <key>, reads from stdin.
                                    bedrock also needs --region <region>;
                                    it stays a workspace secret.
  rm <provider> [--label <label>]   Remove the OAuth credential, the
                                    matching API-key secret(s) and the
                                    provider keys you added. --label
                                    removes only the key with that label.
  usage [<provider>] [--json]       Show the plan usage of each ChatGPT and
                                    Claude login: the 5-hour and weekly
                                    windows, the share used and when each
                                    resets. Kortix asks the provider at most
                                    once a minute per login; this spends no
                                    plan quota. openai, chatgpt and codex
                                    name ChatGPT; claude names Claude.
                                    Includes the logins stored on the
                                    workspace (--workspace, default: linked).
  retry [<provider>]                End the rate-limit rest of the account's
                                    stored provider accounts now (e.g. after
                                    resetting ChatGPT usage). openai, chatgpt
                                    and codex name ChatGPT connections. With no
                                    provider, every account still cooling down.
                                    Otherwise the gateway re-tries one every
                                    15 min on its own. Includes the logins
                                    stored on the workspace (--workspace,
                                    default: linked).
  custom ls [--json]                List custom OpenAI-compatible endpoints.
  custom set <id> --base-url <url> --model <model>[=<name>] [--model …]
             [--name <name>] [--key-stdin]
                                    Create or replace an endpoint. --model
                                    repeats; it replaces the model list.
                                    --name defaults to <id>. --key-stdin
                                    saves the API key read from stdin as
                                    CUSTOM_<ID>_API_KEY.
  custom rm <id>                    Remove the endpoint and its
                                    CUSTOM_<ID>_API_KEY secret.

Known API-key providers (provider → workspace secret(s)):
  anthropic       → ANTHROPIC_API_KEY
  openai          → OPENAI_API_KEY
  openrouter      → OPENROUTER_API_KEY
  google          → GOOGLE_GENERATIVE_AI_API_KEY
  groq            → GROQ_API_KEY
  xai             → XAI_API_KEY
  deepseek        → DEEPSEEK_API_KEY
  mistral         → MISTRAL_API_KEY
  opencode        → OPENCODE_API_KEY (OpenCode Zen)
  opencode-go     → OPENCODE_GO_API_KEY (OpenCode Go)
  bedrock         → AWS_BEARER_TOKEN_BEDROCK + AWS_REGION (--region)
  platinum        → PLATINUM_API_KEY (Platinum Inference; models listed live)

Global options:
  --workspace <id>   Operate on this workspace id (default: linked).
  --host <name>      Operate against a non-default Kortix host.
  --region <region>  (set bedrock) AWS region, e.g. us-east-1.
  --label <label>    (set, rm) The provider key's name, as Models →
                     Providers shows it.
  --private          (set) Only you can use the new key.
  -h, --help         Show this help.

Examples:
  kortix providers set anthropic "$KEY"
  kortix providers set openrouter "$KEY" --private --label "My OpenRouter key"
  kortix providers rm openrouter --label "My OpenRouter key"
  printf %s "$KEY" | kortix providers custom set my-vllm \\
    --base-url https://llm.example.com/v1 --model "qwen-3=Qwen 3" --key-stdin
`;

const LOGIN_HELP = help`Usage: kortix providers login <provider> [options]

Start the OAuth device-code flow for openai, opencode, or opencode-go.
\`claude\` adds your own Claude Pro or Max subscription as a Claude account of the
workspace: Claude models (claude-agent/opus, fable, sonnet, haiku) run through
Claude Code on it. You approve on claude.com and paste the code it shows. The
account is shared with everyone in this workspace when you may share workspace
keys (project.secret.write); otherwise only you can use it. --private keeps it
to you. Change who can use it in the web under Models → Providers → Anthropic.

Options:
  --workspace <id>    Operate on this workspace id (default: linked).
  --host <name>       Operate against a non-default Kortix host.
  --token-stdin       (claude) Read a token made with \`claude setup-token\` from stdin.
  --private           (claude) Only you can use the new Claude account.
  -h, --help          Show this help without starting OAuth.

Example:
  kortix providers login claude
  claude setup-token   # on your computer, then:
  printf %s "$TOKEN" | kortix providers login claude --token-stdin
`;

// ── provider → required project-secret(s) for the API-key flow ────────────
// Sourced from @kortix/llm-catalog's Kortix-owned auth requirement — NOT the
// raw models.dev env list, which for some providers (Bedrock) includes an
// auth method (SigV4 access keys) Kortix's transport doesn't implement. See
// packages/llm-catalog/src/auth-requirements.ts for the full rationale; this
// is the single declaration the web connect modal, the connected-provider
// gate, and this CLI all derive from, so they can't drift.
//
// Every provider here has exactly one required method today. All but bedrock
// need one secret (`set <provider> <key>`); bedrock needs two (bearer token
// + region), handled specially in providersSet/providersRm below.
export const PROVIDER_CATALOG_ID: Record<string, string> = {
  anthropic: 'anthropic',
  openai: 'openai',
  openrouter: 'openrouter',
  google: 'google',
  groq: 'groq',
  xai: 'xai',
  deepseek: 'deepseek',
  mistral: 'mistral',
  opencode: 'opencode',
  'opencode-go': 'opencode-go',
  bedrock: 'amazon-bedrock',
  platinum: 'platinum',
};

export const PROVIDER_ENV_VARS: Record<string, string[]> = Object.fromEntries(
  Object.entries(PROVIDER_CATALOG_ID).map(([cliName, catalogId]) => {
    const catalogProvider = CATALOG.providers.find((p) => p.id === catalogId);
    return [cliName, catalogProvider ? primaryAuthEnvVars(catalogProvider) : []];
  }),
);

/** ANY-OF-methods (single method for every CLI-known provider today), ALL-
 *  OF-vars-within-it — same predicate `use-connected-providers.ts` uses in
 *  the web modal, so `providers ls` never disagrees with it. */
export function isProviderConnected(envVars: string[], secretNames: Set<string>): boolean {
  return (
    envVars.length > 0 &&
    isProviderAuthSatisfied({ methods: [{ envVars }] }, (v) => secretNames.has(v))
  );
}

// Providers that support the OAuth device-code flow: the ones the API's
// `oauthProvider()` serves (apps/api/src/projects/routes/provider-oauth.ts).
const OAUTH_PROVIDERS = new Set(['openai', 'opencode', 'opencode-go']);

type CtxOpts = { projectArg?: string; hostArg?: string };
type ProjectCtx = { client: ApiClient; projectId: string };

// ── provider keys (named accounts) ────────────────────────────────────────
// With the workspace flag `pooled_provider_secrets` on (the default since
// 2026-10-31), the web Models panel (Models → Providers) lists only named
// provider accounts, `kortix.account_secret_resources`. `set` and `rm` use
// them then, as the web and the TUI do; with the flag off they keep the
// legacy workspace secrets (`/workspaces/:id/secrets`). `ls` lists both,
// always: the web dialog adds a named account whatever the flag says.

/** The server's limit on a provider key's label (`secret-resources.ts` Create). */
const LABEL_MAX = 100;

/** A provider key or login as `GET /workspaces/:id/secret-resources` lists it (never its value). */
type NamedAccount = Pick<
  AccountSecretResource,
  'secret_id' | 'label' | 'provider_id' | 'name' | 'access_mode' | 'created_by' | 'granted_user_ids' | 'verification'
>;

interface NamedAccounts {
  accounts: NamedAccount[];
  /** The caller's user id: who "you" is in each key's access. */
  viewerId: string;
}

/**
 * The workspace's provider keys and the caller, or null while the flag is off.
 * Fail-closed like the SDK's `resolveFeatureFlag`: only `true` turns it on, so
 * a server that predates the flag keeps the legacy secrets.
 */
async function namedAccounts(ctx: ProjectCtx): Promise<NamedAccounts | null> {
  const project = await ctx.client.get<{ experimental?: Record<string, unknown> }>(`/workspaces/${ctx.projectId}`);
  if (project.experimental?.pooled_provider_secrets !== true) return null;
  return listNamedAccounts(ctx);
}

/**
 * Every provider key and login the web Models panel lists, whatever the flag
 * says: a key added in the web dialog is always a named account, so `ls`
 * reads them with no flag check.
 */
async function listNamedAccounts(ctx: ProjectCtx): Promise<NamedAccounts> {
  const [me, list] = await Promise.all([
    ctx.client.get<{ user_id: string }>('/me'),
    ctx.client.get<{ secrets: NamedAccount[] }>(
      `/workspaces/${ctx.projectId}/secret-resources${query({ project_id: ctx.projectId })}`,
    ),
  ]);
  return { accounts: list.secrets, viewerId: me.user_id };
}

/** Who can use a provider key, in the words of the web's access choices. */
function accessText(account: NamedAccount, viewerId: string): string {
  const access = connectionAccessSummary(account, viewerId);
  if (access.kind === 'project') return 'everyone in this workspace';
  if (access.kind === 'you') return 'only you';
  if (access.kind === 'owner') return 'only the person who added it';
  return `${access.count} member${access.count === 1 ? '' : 's'}`;
}

/** The CLI name of a stored provider id (`amazon-bedrock` → `bedrock`); other ids as stored. */
function cliProviderName(providerId: string): string {
  return Object.entries(PROVIDER_CATALOG_ID).find(([, id]) => id === providerId)?.[0] ?? providerId;
}

const quoted = (label: string) => `"${label}"`;

export async function runProviders(argv: string[]): Promise<number> {
  const sub = argv[0];
  const rest = argv.slice(1);
  // login/oauth own dedicated help text; every other subcommand shares HELP.
  const usage = sub === 'login' || sub === 'oauth' ? LOGIN_HELP : HELP;
  const helpCode = splitHelp(argv, usage);
  if (helpCode !== null) return helpCode;
  let projectFlag: string | undefined;
  let hostFlag: string | undefined;
  let regionFlag: string | undefined;
  let accountFlag: string | undefined;
  let json = false;
  let catalog = false;
  let search: string | undefined;
  let custom: CustomFlags = { models: [], keyStdin: false };
  let tokenStdin = false;
  let label: string | undefined;
  let privateKey = false;
  const removes = sub === 'rm' || sub === 'remove' || sub === 'unset';
  try {
    projectFlag = takeFlagValue(rest, ['--project', '--workspace']);
    hostFlag = takeFlagValue(rest, ['--host']);
    regionFlag = takeFlagValue(rest, ['--region']);
    accountFlag = takeFlagValue(rest, ['--account']);
    json = takeFlagBool(rest, ['--json']);
    if (sub === 'login' || sub === 'oauth') tokenStdin = takeFlagBool(rest, ['--token-stdin']);
    if (sub === 'set' || removes) label = takeFlagValue(rest, ['--label']);
    if (sub === 'set' || sub === 'login' || sub === 'oauth') privateKey = takeFlagBool(rest, ['--private']);
    if (sub === 'ls' || sub === 'list') {
      catalog = takeFlagBool(rest, ['--catalog']);
      search = takeFlagValue(rest, ['--search']);
    }
    if (sub === 'custom') {
      custom = {
        name: takeFlagValue(rest, ['--name']),
        baseUrl: takeFlagValue(rest, ['--base-url']),
        models: takeFlagValues(rest, ['--model']),
        keyStdin: takeFlagBool(rest, ['--key-stdin']),
      };
    }
  } catch (err) {
    return fail((err as Error).message);
  }
  // Every known flag is now consumed (splitHelp removed -h/--help above).
  // `ls` takes no positional, so anything left is unknown; the other
  // subcommands take positionals, so only a flag-shaped leftover is. The
  // shared grammar prints `unknown option "<first>"` + the usage, exit 2
  // (command-argv.ts) — the flag a customer guesses (`--available`) can no
  // longer masquerade as a no-op success.
  const leftovers =
    sub === 'ls' || sub === 'list' ? rest : rest.filter((arg) => arg.startsWith('-'));
  const unknown = rejectUnknownArgs(leftovers, usage);
  if (unknown !== null) return unknown;
  if (search !== undefined && !catalog) return fail('--search requires --catalog');
  if (label !== undefined) {
    label = label.trim();
    if (!label) return fail('--label is empty');
    if (label.length > LABEL_MAX) return fail(`--label is longer than ${LABEL_MAX} characters`);
  }
  const ctxOpts: CtxOpts = { projectArg: projectFlag, hostArg: hostFlag };

  switch (sub) {
    case 'ls':
    case 'list':
      return catalog ? providersCatalog(search, json) : providersLs(ctxOpts, json);
    case 'login':
    case 'oauth':
      if (rest[0] === CLAUDE_CLI_PROVIDER) return claudeLogin(ctxOpts, tokenStdin, privateKey);
      if (tokenStdin) return fail('--token-stdin works with `kortix providers login claude` only');
      if (privateKey) return fail('--private works with `kortix providers login claude` only');
      return providersLogin(rest[0], ctxOpts);
    case 'set':
      return providersSet(rest[0], rest[1], { region: regionFlag, label, private: privateKey }, ctxOpts);
    case 'rm':
    case 'remove':
    case 'unset':
      return providersRm(rest[0], label, ctxOpts);
    case 'retry':
      return providersRetry(rest[0], accountFlag, ctxOpts, json);
    case 'usage':
      return providersUsage(rest[0], accountFlag, ctxOpts, json);
    case 'custom':
      return providersCustom(rest[0], rest[1], custom, ctxOpts, json);
    default:
      process.stderr.write(`${status.err(`unknown subcommand "${sub}"`)}\n\n${HELP}`);
      return 2;
  }
}

/** A stored account as `GET /accounts/:id/secret-resources` lists it (no value). */
interface StoredAccount { secret_id: string; label: string; provider_id: string | null; cooldown_until: string | null }

/** ChatGPT connections are stored under the `codex` provider id. */
const RETRY_ALIASES: Record<string, string> = { openai: 'codex', chatgpt: 'codex' };

/** The stored accounts still resting after a provider limit, optionally of one provider. */
export function coolingSecrets<T extends StoredAccount>(rows: T[], provider: string | undefined, now = Date.now()): T[] {
  const want = provider ? (RETRY_ALIASES[provider] ?? provider) : undefined;
  return rows.filter((row) => row.cooldown_until && Date.parse(row.cooldown_until) > now && (!want || row.provider_id === want));
}

async function providersRetry(provider: string | undefined, accountArg: string | undefined, opts: CtxOpts, json: boolean): Promise<number> {
  const ctx = resolveAccountContext({ workspaceArg: opts.projectArg, accountArg, hostArg: opts.hostArg });
  if (!ctx) return 1;
  const base = `/workspaces/${encodeURIComponent(ctx.accountId)}/secret-resources`;
  // Without project_id the list holds only account-wide rows; an OAuth login
  // (ChatGPT, OpenCode) is stored on its project. Optional: no project, no filter.
  const projectId = resolveProjectId(opts.projectArg, { hostArg: opts.hostArg });
  let rows: StoredAccount[];
  try {
    rows = (await ctx.client.get<{ secrets: StoredAccount[] }>(`${base}${query({ project_id: projectId ?? undefined })}`)).secrets;
  } catch (err) {
    return surfaceApiError(err);
  }
  const cooling = coolingSecrets(rows, provider);
  const retried: string[] = [];
  for (const row of cooling) {
    try {
      await ctx.client.post(`${base}/${encodeURIComponent(row.secret_id)}/retry`, {});
      retried.push(row.secret_id);
    } catch (err) {
      return surfaceApiError(err);
    }
  }
  if (json) {
    emitJson({ retried });
    return 0;
  }
  if (!cooling.length) {
    process.stdout.write(`${status.ok(`No ${provider ? `${provider} ` : ''}account is cooling down.`)}\n`);
    return 0;
  }
  for (const row of cooling) process.stdout.write(`${status.ok(`${row.label} (${row.provider_id}) is usable again.`)}\n`);
  return 0;
}

/** The plan usage a subscription login reports (`usage` on a listed secret resource). */
export interface PlanUsage {
  windows: Array<{ id: string; window_minutes: number | null; used_percent: number; resets_at: string | null }>;
  limited: boolean;
  observed_at: string;
}

/** Who a subscription login signs in as (`provider_account` on a listed secret resource). */
export interface PlanAccount { email: string | null; plan: string | null }

/** `person@example.test · Pro`, leaving out an email the label already shows; null when the provider says nothing. */
export function planAccountText(account: PlanAccount | null | undefined, label: string): string | null {
  if (!account) return null;
  const email = account.email && !label.toLowerCase().includes(account.email.toLowerCase()) ? account.email : null;
  const plan = account.plan ? `${account.plan[0]!.toUpperCase()}${account.plan.slice(1)}` : null;
  return [email, plan].filter(Boolean).join(' · ') || null;
}

const USAGE_PROVIDERS: Record<string, string> = {
  openai: 'codex', chatgpt: 'codex', codex: 'codex', claude: 'claude-agent', 'claude-agent': 'claude-agent',
};
const SUBSCRIPTION_PROVIDER_IDS = new Set(Object.values(USAGE_PROVIDERS));

function usageWindowName(id: string): string {
  if (id === 'five_hour') return '5-hour';
  if (id === 'weekly') return 'Weekly';
  const model = /^(?:seven_day|7d)_([a-z]+)$/.exec(id)?.[1];
  return model ? `Weekly ${model[0]!.toUpperCase()}${model.slice(1)}` : id;
}

function usageResetText(iso: string, now: number): string {
  const at = new Date(iso);
  const sameDay = new Date(now).toDateString() === at.toDateString();
  const options: Intl.DateTimeFormatOptions = sameDay ? { hour: '2-digit', minute: '2-digit' }
    : at.getTime() - now < 6 * 86_400_000 ? { weekday: 'short', hour: '2-digit', minute: '2-digit' } : { month: 'short', day: 'numeric' };
  return new Intl.DateTimeFormat(undefined, options).format(at);
}

/** One line per plan window: name, a 10-cell bar, the share used, and the reset. */
export function planUsageLines(usage: PlanUsage | null | undefined, now = Date.now()): string[] {
  if (!usage?.windows.length) return ['  Usage appears after the first request.'];
  return usage.windows.map((window) => {
    const cells = Math.round(Math.min(100, window.used_percent) / 10);
    const bar = `${'█'.repeat(cells)}${'░'.repeat(10 - cells)}`;
    const full = window.used_percent >= 100 || (usage.limited && window.used_percent >= 90);
    const reset = window.resets_at && Date.parse(window.resets_at) > now ? usageResetText(window.resets_at, now) : null;
    const tail = full ? `limit reached${reset ? `, resets ${reset}` : ''}` : reset ? `resets ${reset}` : '';
    return `  ${usageWindowName(window.id).padEnd(13)} ${bar} ${`${Math.round(window.used_percent)}%`.padStart(4)}  ${tail}`.trimEnd();
  });
}

async function providersUsage(provider: string | undefined, accountArg: string | undefined, opts: CtxOpts, json: boolean): Promise<number> {
  const want = provider ? USAGE_PROVIDERS[provider] : undefined;
  if (provider && !want) return fail(`"${provider}" has no plan usage. Use openai, chatgpt, codex or claude.`);
  const ctx = resolveAccountContext({ workspaceArg: opts.projectArg, accountArg, hostArg: opts.hostArg });
  if (!ctx) return 1;
  const base = `/workspaces/${encodeURIComponent(ctx.accountId)}/secret-resources`;
  const projectId = resolveProjectId(opts.projectArg, { hostArg: opts.hostArg });
  let rows: Array<StoredAccount & { usage?: PlanUsage | null; provider_account?: PlanAccount | null }>;
  try {
    rows = (await ctx.client.get<{ secrets: Array<StoredAccount & { usage?: PlanUsage | null; provider_account?: PlanAccount | null }> }>(`${base}${query({ project_id: projectId ?? undefined })}`)).secrets;
  } catch (err) {
    return surfaceApiError(err);
  }
  const logins = rows.filter((row) => row.provider_id && SUBSCRIPTION_PROVIDER_IDS.has(row.provider_id) && (!want || row.provider_id === want));
  const accounts = await Promise.all(logins.map(async (row) => {
    // A refresh the server cannot make keeps the snapshot the list carried.
    const fresh = await ctx.client.post<{ usage: PlanUsage | null; provider_account?: PlanAccount | null }>(`${base}/${encodeURIComponent(row.secret_id)}/usage`, {})
      .catch(() => null);
    return {
      secret_id: row.secret_id, label: row.label, provider_id: row.provider_id,
      provider_account: fresh?.provider_account ?? row.provider_account ?? null,
      usage: fresh?.usage ?? row.usage ?? null,
    };
  }));
  if (json) {
    emitJson({ accounts });
    return 0;
  }
  if (!accounts.length) {
    process.stdout.write(`No ${provider ? `${provider} ` : 'ChatGPT or Claude '}login is connected. Run \`kortix providers login openai\` or \`kortix providers login claude\`.\n`);
    return 0;
  }
  for (const account of accounts) {
    const who = planAccountText(account.provider_account, account.label);
    process.stdout.write(`${C.bold}${account.label}${C.reset} ${C.dim}(${[account.provider_id === 'codex' ? 'ChatGPT' : 'Claude', who].filter(Boolean).join(' · ')})${C.reset}\n`);
    process.stdout.write(`${planUsageLines(account.usage).join('\n')}\n`);
  }
  return 0;
}

function providersCatalog(search: string | undefined, json: boolean): number {
  const query = (search ?? '').trim().toLowerCase();
  const providers = CATALOG.providers
    .filter((provider) => `${provider.id} ${provider.name}`.toLowerCase().includes(query))
    .map((provider) => ({
      id: provider.id, name: provider.name,
      env: primaryAuthEnvVars(provider), doc: provider.doc,
    }));
  if (json) emitJson({ providers });
  else {
    for (const provider of providers) {
      process.stdout.write(`${provider.id}  ${provider.name}  ${provider.env.join(' + ') || '(no API-key secrets)'}\n`);
    }
    if (!providers.length) process.stdout.write('No providers match your search.\n');
  }
  return 0;
}

async function providersLs(opts: CtxOpts, json = false): Promise<number> {
  const ctx = await resolveProjectContext(opts);
  if (!ctx) return 1;

  let oauthList: OauthListResponse;
  let secrets: { items: ProjectSecret[] };
  let named: NamedAccounts;
  try {
    [oauthList, secrets, named] = await Promise.all([
      ctx.client.get<OauthListResponse>(`/workspaces/${ctx.projectId}/oauth`),
      ctx.client.get<{ items: ProjectSecret[] }>(`/workspaces/${ctx.projectId}/secrets`),
      listNamedAccounts(ctx),
    ]);
  } catch (err) {
    return surfaceApiError(err);
  }
  // Every provider key and login the Models panel lists; null-provider rows are not provider credentials.
  const accounts = named.accounts.filter((a) => a.provider_id);

  if (json) {
    emitJson({ oauth: oauthList.items, secrets: secrets.items, accounts });
    return 0;
  }

  process.stdout.write('\n');
  const setSecretNames = new Set(secrets.items.map((s) => s.name));

  if (oauthList.items.length === 0 && setSecretNames.size === 0 && accounts.length === 0) {
    process.stdout.write(
      `  ${C.dim}No providers configured. Try:${C.reset}\n` +
        `    ${C.cyan}kortix providers login openai${C.reset}\n` +
        `    ${C.cyan}kortix providers set anthropic sk-ant-...${C.reset}\n\n`,
    );
    return 0;
  }

  if (oauthList.items.length > 0) {
    process.stdout.write(`  ${C.bold}OAuth${C.reset}\n`);
    const nameW = Math.max(...oauthList.items.map((c) => c.provider_id.length), 14);
    process.stdout.write(
      `  ${C.dim}${pad('PROVIDER', nameW)}   EXPIRES IN     UPDATED${C.reset}\n`,
    );
    for (const c of oauthList.items) {
      const expIn = c.expires_in_ms === null ? 'never' : formatDuration(c.expires_in_ms);
      // `dateFallback: {}` prints the locale's numeric date (9/25/2026) past 30 days.
      const ts = formatRelative(c.updated_at, { dateFallback: {} });
      process.stdout.write(
        `  ${pad(c.provider_id, nameW)}   ${pad(expIn, 13)}  ${C.faded}${ts}${C.reset}\n`,
      );
    }
    process.stdout.write('\n');
  }

  if (accounts.length > 0) {
    const rows = accounts
      .map((a) => ({ provider: cliProviderName(a.provider_id!), label: a.label, access: accessText(a, named.viewerId) }))
      .sort((x, y) => x.provider.localeCompare(y.provider) || x.label.localeCompare(y.label));
    process.stdout.write(`  ${C.bold}Provider keys and accounts${C.reset} ${C.dim}(web: Models → Providers)${C.reset}\n`);
    const nameW = Math.max(...rows.map((r) => r.provider.length), 14);
    const labelW = Math.max(...rows.map((r) => r.label.length), 5);
    process.stdout.write(`  ${C.dim}${pad('PROVIDER', nameW)}   ${pad('LABEL', labelW)}   WHO CAN USE IT${C.reset}\n`);
    for (const r of rows) {
      process.stdout.write(`  ${pad(r.provider, nameW)}   ${pad(r.label, labelW)}   ${C.dim}${r.access}${C.reset}\n`);
    }
    process.stdout.write('\n');
  }

  const keyRows: Array<{ provider: string; env: string }> = [];
  // An OpenCode login is stored as the provider's key secret; list it once, as OAuth.
  const oauthIds = new Set(oauthList.items.map((c) => c.provider_id));
  for (const [provider, envVars] of Object.entries(PROVIDER_ENV_VARS)) {
    if (!oauthIds.has(provider) && isProviderConnected(envVars, setSecretNames)) {
      keyRows.push({ provider, env: envVars.join(' + ') });
    }
  }
  if (keyRows.length > 0) {
    // The Models panel does not list these secrets.
    process.stdout.write(
      `  ${C.bold}API keys${C.reset} ${C.dim}(legacy workspace secrets, shared with everyone; not under Models → Providers)${C.reset}\n`,
    );
    const nameW = Math.max(...keyRows.map((r) => r.provider.length), 14);
    for (const r of keyRows) {
      process.stdout.write(`  ${pad(r.provider, nameW)}   ${C.dim}${r.env}${C.reset}\n`);
    }
    process.stdout.write('\n');
  }

  return 0;
}

/** `kortix providers login claude`: the caller's own Claude subscription, for Claude models. */
const CLAUDE_CLI_PROVIDER = 'claude';

interface ClaudeLoginStartResponse { flow_id: string; authorize_url: string; expires_at: string }
interface ClaudeConnectedResponse { connected: boolean; secret_id?: string }

type ClaudeSharing = { mode: 'project' } | { mode: 'private' };

/**
 * Who a new Claude account is for. The web's default, "Everyone in this
 * workspace", needs `project.secret.write` (the API refuses wider sharing
 * without it), so the caller's own verdict decides: everyone when allowed,
 * only the caller otherwise. A probe that fails counts as not allowed.
 */
async function claudeSharing(ctx: ProjectCtx & { auth: Auth }): Promise<ClaudeSharing> {
  try {
    const me = await ctx.client.get<{ user_id: string }>('/me');
    const verdict = await withCliErrors(ctx.auth, () =>
      probeEffectivePermission(ctx.projectId, me.user_id, {
        action: 'project.secret.write',
        resourceType: 'project',
        resourceId: ctx.projectId,
      }),
    );
    return verdict.allowed ? { mode: 'project' } : { mode: 'private' };
  } catch {
    return { mode: 'private' };
  }
}

/** A prompt whose stdin closed answers '': the caller's empty-value refusal (a non-zero exit) runs. */
const emptyOnEnd = (read: Promise<string>): Promise<string> =>
  read.catch((err: unknown) => {
    if (err instanceof EndOfInputError) return '';
    throw err;
  });

const claudeSharingText = (sharing: ClaudeSharing) =>
  sharing.mode === 'project' ? 'shared with everyone in this workspace' : 'only you can use it';

async function claudeLogin(opts: CtxOpts, tokenStdin: boolean, forcePrivate: boolean): Promise<number> {
  const ctx = await resolveProjectContext(opts);
  if (!ctx) return 1;
  const sharing: ClaudeSharing = forcePrivate ? { mode: 'private' } : await claudeSharing(ctx);
  const done = (result: ClaudeConnectedResponse) => {
    if (!result.connected || !result.secret_id) {
      process.stderr.write(`${status.err('Kortix did not store the Claude login. Run the command again.')}\n`);
      return 1;
    }
    process.stdout.write(
      `\n${status.ok('Connected your Claude subscription')}\n` +
        `  ${C.dim}Added a Claude account: ${claudeSharingText(sharing)}. Claude models (claude-agent/opus, fable, sonnet, haiku) now run on your plan` +
        `${sharing.mode === 'project' ? ' in this workspace\'s sessions' : ' in your sessions'}.${C.reset}\n` +
        `  ${C.dim}Change who can use it in the web under Models → Providers → Anthropic.${C.reset}\n\n`,
    );
    return 0;
  };
  if (tokenStdin) {
    const token = (await Bun.stdin.text()).trim();
    if (!token) return fail('stdin is empty: pipe the token `claude setup-token` printed');
    try {
      return done(await ctx.client.put<ClaudeConnectedResponse>(`/workspaces/${ctx.projectId}/claude-subscription/token`, { token, sharing }));
    } catch (err) {
      return surfaceApiError(err);
    }
  }
  let flow: ClaudeLoginStartResponse;
  try {
    flow = await ctx.client.post<ClaudeLoginStartResponse>(`/workspaces/${ctx.projectId}/claude-subscription/login/start`, { sharing });
  } catch (err) {
    return surfaceApiError(err);
  }
  process.stdout.write(
    `\n  ${C.bold}Connect your Claude subscription${C.reset}\n` +
      `  ${C.dim}The new Claude account: ${claudeSharingText(sharing)}${sharing.mode === 'project' ? ' (pass --private to keep it to you)' : ''}.${C.reset}\n` +
      `  ${C.dim}Open this URL, sign in with the Claude account that has your plan, and approve:${C.reset}\n` +
      `    ${C.cyan}${flow.authorize_url}${C.reset}\n` +
      `  ${C.dim}Then paste the code Claude shows you.${C.reset}\n\n`,
  );
  openInBrowser(flow.authorize_url);
  let code: string;
  try {
    code = (await readVisible('  Code from claude.com: ')).trim();
  } catch (err) {
    if (!(err instanceof EndOfInputError)) throw err;
    // No terminal to paste into (an agent, CI, `</dev/null`): nothing is stored, so the exit code says so.
    process.stderr.write(
      `\n${status.err('stdin closed before a code arrived: Kortix stored no Claude login.')}\n` +
        `  ${C.dim}Run it in a terminal and paste the code, or pipe a token made with \`claude setup-token\`:${C.reset}\n` +
        `    printf %s "$TOKEN" | kortix providers login claude --token-stdin\n`,
    );
    return 1;
  }
  if (!code) return fail('No code entered. Run the command again.');
  try {
    return done(await ctx.client.post<ClaudeConnectedResponse>(`/workspaces/${ctx.projectId}/claude-subscription/login/complete`, { flow_id: flow.flow_id, code }));
  } catch (err) {
    return surfaceApiError(err);
  }
}

async function providersLogin(provider: string | undefined, opts: CtxOpts): Promise<number> {
  if (!provider)
    return fail('Pass a provider: kortix providers login <openai|opencode|opencode-go|claude>');
  if (!OAUTH_PROVIDERS.has(provider)) {
    const keyHint = PROVIDER_ENV_VARS[provider]?.length
      ? `  ${C.dim}Try \`kortix providers set ${provider} <key>\` instead.${C.reset}\n`
      : '';
    process.stderr.write(
      `${status.err(`OAuth not supported for "${provider}". Supported: ${[...OAUTH_PROVIDERS].join(', ')}.`)}\n` +
        keyHint,
    );
    return 2;
  }
  const ctx = await resolveProjectContext(opts);
  if (!ctx) return 1;

  // Kick off the device-code flow.
  let flow: OauthFlowStartResponse;
  try {
    flow = await ctx.client.post<OauthFlowStartResponse>(
      `/workspaces/${ctx.projectId}/oauth/${provider}/start`,
      {},
    );
  } catch (err) {
    return surfaceApiError(err);
  }

  process.stdout.write(
    `\n  ${C.bold}Authorize ${provider}${C.reset}\n` +
      `  ${C.dim}Open this URL and enter the code:${C.reset}\n` +
      `    ${C.cyan}${flow.verification_url}${C.reset}\n` +
      `    code: ${C.bold}${flow.user_code}${C.reset}\n` +
      `  ${C.dim}Waiting for approval (Ctrl+C to cancel)…${C.reset}\n`,
  );
  openInBrowser(flow.verification_url);

  // Poll until success/failure/expiry.
  const deadline = flow.expires_at;
  let intervalMs = flow.interval_ms || 5000;
  while (Date.now() < deadline) {
    await sleep(intervalMs);
    let resp: OauthPollResponse;
    try {
      resp = await ctx.client.post<OauthPollResponse>(
        `/workspaces/${ctx.projectId}/oauth/${provider}/poll`,
        { flow_id: flow.flow_id },
      );
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) continue;
      return surfaceApiError(err);
    }
    if (resp.status === 'success') {
      process.stdout.write(
        `\n${status.ok(`Authorized ${C.bold}${provider}${C.reset} on this workspace`)}\n`,
      );
      const exp = resp.credential.expires_in_ms;
      if (exp !== null) {
        process.stdout.write(
          `  ${C.dim}Token expires in ${formatDuration(exp)}; Kortix refreshes it before then.${C.reset}\n\n`,
        );
      } else {
        process.stdout.write('\n');
      }
      return 0;
    }
    if (resp.status === 'pending') {
      intervalMs = resp.next_poll_ms || intervalMs;
      continue;
    }
    if (resp.status === 'expired') {
      process.stderr.write(`${status.err('Authorization timed out. Run the command again.')}\n`);
      return 1;
    }
    if (resp.status === 'failed') {
      process.stderr.write(`${status.err(`Authorization failed: ${resp.error}`)}\n`);
      return 1;
    }
  }
  process.stderr.write(`${status.err('Authorization deadline passed.')}\n`);
  return 1;
}

interface SetFlags { region?: string; label?: string; private: boolean }

async function providersSet(
  provider: string | undefined,
  key: string | undefined,
  flags: SetFlags,
  opts: CtxOpts,
): Promise<number> {
  if (!provider) return fail('Pass a provider: kortix providers set <provider> [<key>]');
  const envVars = PROVIDER_ENV_VARS[provider];
  if (!envVars || envVars.length === 0) {
    process.stderr.write(
      `${status.err(`Unknown provider "${provider}".`)}\n` +
        `  ${C.dim}Known: ${Object.keys(PROVIDER_ENV_VARS).join(', ')}${C.reset}\n` +
        `  ${C.dim}Or set a custom env directly: \`kortix secrets set NAME=value\`${C.reset}\n`,
    );
    return 2;
  }
  // A provider key holds ONE value. Bedrock needs two (bearer token + region),
  // so it cannot be one provider key today (the web keeps it on the workspace-
  // secret form too) and stays two legacy workspace secrets.
  const single = envVars.length === 1;
  if (!single && (flags.private || flags.label !== undefined)) {
    return fail(`${provider} is saved as workspace secrets, shared with everyone in this workspace: --private and --label do not apply.`);
  }
  const regionFlag = flags.region;

  // bedrock is the one provider needing two values (bearer token + region) —
  // every other provider stays the plain single-key flow below.
  const values: Record<string, string> = {};
  if (envVars.length === 1) {
    const envVar = envVars[0]!;
    const value = key || (await emptyOnEnd(readSecret(`Enter ${envVar} (input hidden): `)));
    if (!value) {
      process.stderr.write(`${status.err('Empty value — aborting.')}\n`);
      return 1;
    }
    values[envVar] = value;
  } else {
    const [tokenVar, regionVar] = envVars; // ['AWS_BEARER_TOKEN_BEDROCK', 'AWS_REGION']
    const token = key || (await emptyOnEnd(readSecret(`Enter ${tokenVar} (input hidden): `)));
    if (!token) {
      process.stderr.write(`${status.err('Empty value — aborting.')}\n`);
      return 1;
    }
    let region = regionFlag;
    if (!region && process.stdin.isTTY) {
      region = await emptyOnEnd(readVisible(`Enter ${regionVar} (e.g. us-east-1): `));
    }
    if (!region) {
      process.stderr.write(
        `${status.err(`${provider} also needs a region: pass --region <region>.`)}\n` +
          `  ${C.dim}Example: kortix providers set bedrock <token> --region us-east-1${C.reset}\n`,
      );
      return 2;
    }
    values[tokenVar!] = token;
    values[regionVar!] = region;
  }

  const ctx = await resolveProjectContext(opts);
  if (!ctx) return 1;

  if (single) {
    let named: NamedAccounts | null;
    try {
      named = await namedAccounts(ctx);
    } catch (err) {
      return surfaceApiError(err);
    }
    if (named) {
      const [envVar, value] = Object.entries(values)[0]!;
      return saveProviderKey(ctx, named, { provider, envVar, value, label: flags.label, private: flags.private });
    }
    // The flag is off: a legacy secret is shared with the whole workspace, so
    // saving one would quietly widen what the caller asked for.
    if (flags.private || flags.label !== undefined) {
      return fail(
        'Provider keys (pooled_provider_secrets) are off for this workspace, so --private and --label do not apply. ' +
          'Without them the key is saved as a workspace secret, shared with everyone in this workspace.',
      );
    }
  }

  try {
    for (const [name, value] of Object.entries(values)) {
      // `kortix providers set` is the BYOK model-credential command — it KNOWS
      // this value is a provider key, so it says so. It used to omit the pair
      // and lean on the server inferring "model credential" from the secret's
      // NAME, which is a guess the server has no business making: models.dev
      // claims `GITHUB_TOKEN` for `github-copilot`, so an ordinary GitHub PAT
      // was classified as a Copilot key and withheld from the sandbox.
      // The API files it as the workspace's named "Workspace key" (one store
      // for provider keys); a Bedrock region lands next to its key there.
      await ctx.client.post<ProjectSecret>(`/workspaces/${ctx.projectId}/secrets`, {
        name,
        value,
        strategy: 'broker',
        consumer: 'llm_gateway',
      });
    }
  } catch (err) {
    return surfaceApiError(err);
  }
  process.stdout.write(
    `\n${status.ok(`Saved ${C.bold}${Object.keys(values).join(', ')}${C.reset} for ${C.bold}${provider}${C.reset}`)}\n` +
      `  ${C.dim}Saved as a workspace key, shared with everyone in this workspace. Listed in the web under Models → Providers.${C.reset}\n` +
      `  ${C.dim}The LLM gateway uses it; the key never enters a sandbox.${C.reset}\n\n`,
  );
  return 0;
}

interface ProviderKeyInput {
  provider: string;
  envVar: string;
  value: string;
  label?: string;
  private: boolean;
}

/**
 * Save one provider key the way the web Models panel does. A key of the
 * caller's with the same provider and label gets the new value (the legacy
 * secret was an upsert too) and keeps its access; `--private` narrows it.
 * Otherwise a new key: everyone in the workspace by default, only the caller
 * with `--private` (the API grants the creator itself).
 */
async function saveProviderKey(ctx: ProjectCtx, named: NamedAccounts, input: ProviderKeyInput): Promise<number> {
  const providerId = PROVIDER_CATALOG_ID[input.provider]!;
  const providerName = CATALOG.providers.find((p) => p.id === providerId)?.name ?? input.provider;
  const label = input.label ?? `${providerName} key`;
  const base = `/workspaces/${ctx.projectId}/secret-resources`;
  const mine = named.accounts.filter((a) => a.provider_id === providerId && a.created_by === named.viewerId);
  const existing = mine.find((a) => a.label === label);
  let saved: NamedAccount;
  try {
    if (existing) {
      const path = `${base}/${encodeURIComponent(existing.secret_id)}`;
      saved = await ctx.client.put<NamedAccount>(`${path}/value`, { value: input.value });
      if (input.private && connectionAccessSummary(saved, named.viewerId).kind !== 'you') {
        saved = await ctx.client.put<NamedAccount>(`${path}/access`, { mode: 'members', user_ids: [] });
      }
    } else {
      saved = await ctx.client.post<NamedAccount>(base, {
        project_id: ctx.projectId,
        ...providerKeyAccessFields(input.private ? 'private' : 'project', []),
        provider_id: providerId,
        name: input.envVar,
        label,
        value: input.value,
        consumer: 'llm_gateway',
        strategy: 'broker',
      });
    }
  } catch (err) {
    // A workspace-wide key needs `project.secret.write`. Never fall back to a
    // private key on the caller's behalf: say how to ask for one.
    if (!existing && !input.private && err instanceof ApiError && err.status === 403) {
      process.stderr.write(
        `${status.err(err.message || 'Forbidden')}\n` +
          `  Sharing a key with everyone in this workspace needs the project.secret.write permission.\n` +
          `  To save it for only you, run the command again with ${C.cyan}--private${C.reset}.\n`,
      );
      return 1;
    }
    return surfaceApiError(err);
  }
  const who =
    connectionAccessSummary(saved, named.viewerId).kind === 'you'
      ? 'Only you can use it.'
      : `Shared with ${accessText(saved, named.viewerId)}.`;
  const others = mine.filter((a) => a.secret_id !== saved.secret_id);
  // The API checked the key with one cheap call to the provider. A refused key
  // stays saved: the line says what the provider said.
  const check = saved.verification;
  const checked = !check
    ? ''
    : check.status === 'verified'
      ? `${status.ok(`${input.provider} accepted the key.`)}\n`
      : check.status === 'invalid'
        ? `${status.warn(`${input.provider} refused the key: ${check.message}`)}\n` +
          `  ${C.dim}Replace it with: printf %s "$KEY" | kortix providers set ${input.provider}${input.label ? ` --label ${quoted(input.label)}` : ''}${C.reset}\n`
        : `${status.info(`Not verified: ${check.message}`)}\n`;
  process.stdout.write(
    `\n${status.ok(`${existing ? 'Replaced the value of' : 'Saved'} ${C.bold}${quoted(saved.label)}${C.reset} (${input.envVar}) for ${C.bold}${input.provider}${C.reset}`)}\n` +
      `  ${C.dim}${who} Listed in the web under Models → Providers.${C.reset}\n` +
      `  ${C.dim}The LLM gateway uses it; the key never enters a sandbox.${C.reset}\n` +
      checked +
      (!existing && others.length
        ? `  ${C.dim}Your other ${input.provider} key${others.length === 1 ? '' : 's'}: ${others.map((a) => quoted(a.label)).join(', ')}. ` +
          `To replace one, pass its --label.${C.reset}\n`
        : '') +
      '\n',
  );
  return 0;
}

async function providersRm(provider: string | undefined, label: string | undefined, opts: CtxOpts): Promise<number> {
  if (!provider) return missing('a provider');
  if (provider === CLAUDE_CLI_PROVIDER && label !== undefined) {
    return fail('--label does not apply to claude: `kortix providers rm claude` deletes your Claude accounts.');
  }
  const ctx = await resolveProjectContext(opts);
  if (!ctx) return 1;
  if (provider === CLAUDE_CLI_PROVIDER) {
    try {
      await ctx.client.delete(`/workspaces/${ctx.projectId}/claude-subscription`);
    } catch (err) {
      return surfaceApiError(err);
    }
    process.stdout.write(`${status.ok('Deleted your Claude accounts in this workspace')}\n  ${C.dim}Claude accounts others shared with you stay.${C.reset}\n`);
    return 0;
  }

  let named: NamedAccounts | null;
  try {
    named = await namedAccounts(ctx);
  } catch (err) {
    return surfaceApiError(err);
  }
  const providerId = PROVIDER_CATALOG_ID[provider];
  const keys = named && providerId ? named.accounts.filter((a) => a.provider_id === providerId) : [];
  if (label !== undefined) {
    if (!named) return fail('Provider keys (pooled_provider_secrets) are off for this workspace, so --label does not apply.');
    const matches = keys.filter((a) => a.label === label);
    if (!matches.length) {
      process.stderr.write(
        `${status.err(`No ${provider} key is labeled ${quoted(label)}.`)}\n` +
          (keys.length ? `  ${C.dim}${provider} keys: ${keys.map((a) => quoted(a.label)).join(', ')}${C.reset}\n` : ''),
      );
      return 1;
    }
    const failed = await deleteProviderKeys(ctx, matches);
    if (failed !== null) return failed;
    process.stdout.write(`${status.ok(`Removed key ${C.bold}${quoted(label)}${C.reset} for ${C.bold}${provider}${C.reset}`)}\n`);
    return 0;
  }
  // Without --label: the caller's own keys. A key someone else added stays theirs to remove.
  const mine = named ? keys.filter((a) => a.created_by === named.viewerId) : [];
  const othersKeys = keys.filter((a) => !mine.includes(a));

  let removedOauth = false;
  const removedKeys: string[] = [];

  if (OAUTH_PROVIDERS.has(provider)) {
    try {
      await ctx.client.delete(`/workspaces/${ctx.projectId}/oauth/${provider}`);
      removedOauth = true;
    } catch (err) {
      if (!(err instanceof ApiError) || err.status !== 404) {
        return surfaceApiError(err);
      }
    }
  }

  let envVars = PROVIDER_ENV_VARS[provider] ?? [];
  if (named) {
    // Only the legacy secrets that exist. Deleting one needs project.secret.write
    // even when it is missing, and a member who added only a private provider
    // key may lack it; that 403 would stop the removal of their own key.
    try {
      const { items } = await ctx.client.get<{ items: ProjectSecret[] }>(`/workspaces/${ctx.projectId}/secrets`);
      const stored = new Set(items.map((s) => s.name));
      envVars = envVars.filter((envVar) => stored.has(envVar));
    } catch (err) {
      return surfaceApiError(err);
    }
  }
  for (const envVar of envVars) {
    try {
      await ctx.client.delete(`/workspaces/${ctx.projectId}/secrets/${envVar}`);
      removedKeys.push(envVar);
    } catch (err) {
      if (!(err instanceof ApiError) || err.status !== 404) {
        return surfaceApiError(err);
      }
    }
  }
  const failed = await deleteProviderKeys(ctx, mine);
  if (failed !== null) return failed;

  const stays = othersKeys.length
    ? `  ${C.dim}Keys others added stay: ${othersKeys.map((a) => quoted(a.label)).join(', ')}. ` +
      `To remove one, pass --label <label>.${C.reset}\n`
    : '';
  if (!removedOauth && removedKeys.length === 0 && mine.length === 0) {
    process.stdout.write(`  ${C.dim}Nothing to remove for "${provider}".${C.reset}\n${stays}`);
    return 0;
  }
  const parts: string[] = [];
  if (removedOauth) parts.push('OAuth credential');
  if (removedKeys.length > 0)
    parts.push(`secret${removedKeys.length > 1 ? 's' : ''} ${removedKeys.join(', ')}`);
  if (mine.length > 0) parts.push(`key${mine.length > 1 ? 's' : ''} ${mine.map((a) => quoted(a.label)).join(', ')}`);
  process.stdout.write(
    `${status.ok(`Removed ${parts.join(' + ')} for ${C.bold}${provider}${C.reset}`)}\n${stays}`,
  );
  return 0;
}

/** Delete provider keys; one already gone (404) counts as deleted. The exit code of a failure, else null. */
async function deleteProviderKeys(ctx: ProjectCtx, keys: NamedAccount[]): Promise<number | null> {
  for (const key of keys) {
    try {
      await ctx.client.delete(`/workspaces/${ctx.projectId}/secret-resources/${encodeURIComponent(key.secret_id)}`);
    } catch (err) {
      if (!(err instanceof ApiError) || err.status !== 404) return surfaceApiError(err);
    }
  }
  return null;
}

// ── custom OpenAI-compatible endpoints ────────────────────────────────────

interface CustomFlags { name?: string; baseUrl?: string; models: string[]; keyStdin: boolean }

/** `--model id=Name` → `{ id, name }`; a bare id names itself. */
export function parseCustomModel(value: string): { id: string; name: string } {
  const eq = value.indexOf('=');
  if (eq === -1) return { id: value, name: value };
  const id = value.slice(0, eq);
  return { id, name: value.slice(eq + 1) || id };
}

async function providersCustom(
  action: string | undefined,
  id: string | undefined,
  flags: CustomFlags,
  opts: CtxOpts,
  json: boolean,
): Promise<number> {
  if (action === 'ls' || action === 'list') return customLs(opts, json);
  if (action !== 'set' && action !== 'rm' && action !== 'remove') {
    process.stderr.write(`${status.err(`unknown subcommand "custom ${action ?? ''}"`)}\n\n${HELP}`);
    return 2;
  }
  if (!id) return missing('a custom provider id');
  if (action !== 'set') return customRm(id, opts);
  if (!flags.baseUrl) return fail('Pass --base-url <url> (the OpenAI-compatible API root, e.g. https://host/v1).');
  if (flags.models.length === 0) return fail('Pass at least one --model <model>[=<name>].');

  let key: string | undefined;
  if (flags.keyStdin) {
    key = (await Bun.stdin.text()).trim();
    if (!key) return fail('--key-stdin read an empty key.');
  }
  const ctx = await resolveProjectContext(opts);
  if (!ctx) return 1;
  const base = `/workspaces/${ctx.projectId}/custom-providers`;
  let provider: CustomLlmProvider;
  try {
    provider = await ctx.client.put<CustomLlmProvider>(`${base}/${encodeURIComponent(id)}`, {
      name: flags.name ?? id,
      base_url: flags.baseUrl,
      models: flags.models.map(parseCustomModel),
    });
    if (key) {
      // The same write the web Custom form makes: the gateway spends the key,
      // the sandbox never sees it.
      await ctx.client.post<ProjectSecret>(`/workspaces/${ctx.projectId}/secrets`, {
        name: provider.secret_name,
        value: key,
        strategy: 'broker',
        consumer: 'llm_gateway',
      });
      provider = { ...provider, has_key: true };
    }
  } catch (err) {
    return surfaceApiError(err);
  }
  if (json) {
    emitJson(provider);
    return 0;
  }
  process.stdout.write(
    `${status.ok(`Saved ${C.bold}${provider.id}${C.reset} → ${provider.base_url} (${provider.models.length} model${provider.models.length === 1 ? '' : 's'})`)}\n` +
      `  ${C.dim}${provider.has_key ? `Key: ${provider.secret_name}` : `No key. Add one: kortix providers custom set ${provider.id} … --key-stdin`}${C.reset}\n`,
  );
  return 0;
}

async function customLs(opts: CtxOpts, json: boolean): Promise<number> {
  const ctx = await resolveProjectContext(opts);
  if (!ctx) return 1;
  let providers: CustomLlmProvider[];
  try {
    ({ providers } = await ctx.client.get<{ providers: CustomLlmProvider[] }>(
      `/workspaces/${ctx.projectId}/custom-providers`,
    ));
  } catch (err) {
    return surfaceApiError(err);
  }
  if (json) {
    emitJson({ providers });
    return 0;
  }
  if (providers.length === 0) {
    process.stdout.write(
      `  ${C.dim}No custom providers. Try:${C.reset}\n` +
        `    ${C.cyan}kortix providers custom set my-llm --base-url https://host/v1 --model my-model --key-stdin${C.reset}\n`,
    );
    return 0;
  }
  const idW = Math.max(...providers.map((p) => p.id.length), 2);
  process.stdout.write(`  ${C.dim}${pad('ID', idW)}   KEY  ENDPOINT${C.reset}\n`);
  for (const p of providers) {
    const endpoint = p.configured
      ? `${p.base_url}  ${C.dim}${p.models.map((m) => m.id).join(', ')}${C.reset}`
      : `${C.dim}no endpoint (kortix providers custom set ${p.id} --base-url …)${C.reset}`;
    process.stdout.write(`  ${pad(p.id, idW)}   ${p.has_key ? 'yes' : 'no '}  ${endpoint}\n`);
  }
  return 0;
}

/**
 * Remove an endpoint and its key. The DELETE route drops only the definition;
 * the key is the project secret `secret_name` (`CUSTOM_<ID>_API_KEY`), deleted
 * through the secrets route like the web form does. The list says which of
 * the two exist: the secrets DELETE answers 200 either way.
 */
async function customRm(id: string, opts: CtxOpts): Promise<number> {
  const ctx = await resolveProjectContext(opts);
  if (!ctx) return 1;
  const base = `/workspaces/${ctx.projectId}`;
  let provider: CustomLlmProvider | undefined;
  try {
    const { providers } = await ctx.client.get<{ providers: CustomLlmProvider[] }>(`${base}/custom-providers`);
    provider = providers.find((p) => p.id === id);
    if (provider?.configured) {
      await ctx.client.delete(`${base}/custom-providers/${encodeURIComponent(id)}`);
    }
    if (provider?.has_key) {
      await ctx.client.delete(`${base}/secrets/${encodeURIComponent(provider.secret_name)}`);
    }
  } catch (err) {
    return surfaceApiError(err);
  }
  if (!provider || (!provider.configured && !provider.has_key)) {
    process.stdout.write(`  ${C.dim}Nothing to remove for "${id}".${C.reset}\n`);
    return 0;
  }
  const key = provider.has_key ? `${C.bold}${provider.secret_name}${C.reset}` : '';
  process.stdout.write(
    `${status.ok(
      provider.configured
        ? `Removed custom provider ${C.bold}${id}${C.reset}${key ? ` and its key ${key}` : ''}`
        : `Removed key ${key}`,
    )}\n`,
  );
  return 0;
}

// ── helpers ───────────────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  if (ms <= 0) return 'expired';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}
