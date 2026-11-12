import type { ProjectAdminSectionKey } from '../../customize/project-settings/project-admin-sections';

/**
 * The deep search over Workspace settings: the search field under Back in the
 * drilled sidebar (`WorkspaceSettingsSidebarNav`).
 *
 * A section row matches by its own label. Each entry below is one thing a
 * person looks for INSIDE a section: a tab, a card or a settings row. An
 * entry opens its section and, when it has one, the tab its `query` names (a
 * URL param the pane already reads). Then the page scrolls to the text the
 * entry names and marks it (`useSettingsSearchLanding`).
 *
 * `label` is the text the pane renders, character for character: the landing
 * finds the card by that text. `keywords` are what a person might type
 * instead: synonyms, and words the card itself contains. A keyword that names
 * a different card is a defect: that query then opens the wrong place.
 *
 * Labels are English, as in the command palette registry
 * (`apps/web/src/lib/menu-registry.ts`). In another locale the search still
 * opens the section and its tab, but the page may not find the card's text
 * to scroll to.
 */
export interface SettingsSearchEntry {
  id: string;
  section: ProjectAdminSectionKey;
  label: string;
  keywords?: string;
  /** URL params the section's pane reads, such as the Models tab. */
  query?: Record<string, string>;
  /**
   * The text to scroll to, when it differs from `label`. `null`: the entry
   * opens a tab or a view, and there is nothing to scroll to.
   */
  find?: string | null;
}

export const SETTINGS_SEARCH_ENTRIES: readonly SettingsSearchEntry[] = [
  // General
  { id: 'general-icon', section: 'general', label: 'Icon', keywords: 'emoji avatar workspace icon picture' },
  { id: 'general-name', section: 'general', label: 'Workspace name', keywords: 'rename title' },
  {
    id: 'general-effort',
    section: 'general',
    label: 'Default reasoning effort',
    keywords: 'thinking reasoning effort automatic high low',
  },
  {
    id: 'general-pause-triggers',
    section: 'general',
    label: 'Pause all triggers',
    keywords: 'stop disable schedules loops webhooks automations',
  },
  { id: 'general-workspace-id', section: 'general', label: 'Workspace ID', keywords: 'uuid cli api identifier copy' },

  // Danger zone
  { id: 'danger-leave', section: 'danger-zone', label: 'Leave workspace', keywords: 'exit quit remove myself' },
  { id: 'danger-delete', section: 'danger-zone', label: 'Delete workspace', keywords: 'remove destroy erase' },

  // Security
  {
    id: 'security-mfa',
    section: 'security',
    label: 'Require two-factor authentication',
    keywords: '2fa mfa totp authenticator two factor',
  },
  {
    id: 'security-session-length',
    section: 'security',
    label: 'Maximum session length',
    keywords: 'login expiry sign out session lifetime',
  },
  { id: 'security-idle', section: 'security', label: 'Idle timeout', keywords: 'inactive sign out session' },
  {
    id: 'security-oversight',
    section: 'security',
    label: 'Admins can open every session',
    keywords: 'oversight admin view sessions audit',
  },
  {
    id: 'security-active-sessions',
    section: 'security',
    label: 'Active sessions',
    keywords: 'devices signed in logins revoke',
  },
  {
    id: 'security-key-rules',
    section: 'security',
    label: 'Key rules',
    keywords: 'api key policy expiry end date unused keys longest',
  },

  // Branding
  { id: 'branding-name', section: 'branding', label: 'Product name', keywords: 'white label app name rename' },
  { id: 'branding-marks', section: 'branding', label: 'Marks', keywords: 'logo icon favicon white label' },

  // API keys
  {
    id: 'api-keys-oauth',
    section: 'api-keys',
    label: 'OAuth apps',
    keywords: 'oauth client id secret redirect integration application',
  },
  { id: 'api-keys-new', section: 'api-keys', label: 'New key', keywords: 'create api key token pat personal access' },

  // Models: each tab is a `?tab=` value the pane reads (`LLM_TABS`).
  {
    id: 'models-providers',
    section: 'models',
    label: 'Providers',
    keywords: 'provider openai anthropic google openrouter api key connect llm',
    query: { tab: 'providers' },
    find: null,
  },
  {
    id: 'models-models',
    section: 'models',
    label: 'Models',
    keywords: 'model list enable disable default model',
    query: { tab: 'models' },
    find: null,
  },
  {
    id: 'models-custom',
    section: 'models',
    label: 'Custom',
    keywords: 'custom gateway custom provider endpoint base url openai compatible self hosted',
    query: { tab: 'custom' },
    find: null,
  },
  {
    id: 'models-gateway',
    section: 'models',
    label: 'Gateway',
    keywords: 'gateway keys use models anywhere llm gateway access',
    query: { tab: 'gateway' },
    find: null,
  },
  {
    id: 'models-gateway-keys',
    section: 'models',
    label: 'Gateway keys',
    keywords: 'gateway api key token',
    query: { tab: 'gateway' },
  },
  {
    id: 'models-routing',
    section: 'models',
    label: 'Routing',
    keywords: 'fallback route failover model routing order',
    query: { tab: 'routing' },
    find: null,
  },
  {
    id: 'models-costs',
    section: 'models',
    label: 'Costs',
    keywords: 'cost spend money price overview most spend top sessions',
    query: { tab: 'overview' },
    find: null,
  },
  {
    id: 'models-budget',
    section: 'models',
    label: 'Budget',
    keywords: 'spend limit cap monthly budget',
    query: { tab: 'overview' },
  },
  {
    id: 'models-errors',
    section: 'models',
    label: 'Errors by type',
    keywords: 'failures model errors rate limit',
    query: { tab: 'overview' },
  },
  {
    id: 'models-logs',
    section: 'models',
    label: 'Logs',
    keywords: 'requests calls log history llm logs',
    query: { tab: 'logs' },
    find: null,
  },
  {
    id: 'models-chatgpt-usage',
    section: 'models',
    label: 'ChatGPT subscription usage',
    keywords: 'chatgpt openai codex subscription usage limits weekly allowance quota code review',
    query: { tab: 'providers', provider: 'openai' },
    find: null,
  },
  {
    id: 'models-claude-usage',
    section: 'models',
    label: 'Claude subscription usage',
    keywords: 'claude anthropic subscription usage limits weekly allowance quota opus sonnet extra',
    query: { tab: 'providers', provider: 'anthropic' },
    find: null,
  },

  // Connectors: `?scope=` and `?rules=1` (`connector-routes.ts`).
  {
    id: 'connectors-connected',
    section: 'connectors',
    label: 'Connected',
    keywords: 'connected apps integrations installed',
    query: { scope: 'connected' },
    find: null,
  },
  {
    id: 'connectors-channels',
    section: 'connectors',
    label: 'Channels',
    keywords: 'slack teams discord telegram email channel',
    query: { scope: 'channels' },
    find: null,
  },
  {
    id: 'connectors-rules',
    section: 'connectors',
    label: 'Connector rules',
    keywords: 'policies approval permissions allow block rules',
    query: { rules: '1' },
    find: null,
  },

  // Triggers: `?type=` (`parseTriggerFilter`).
  {
    id: 'triggers-schedules',
    section: 'triggers',
    label: 'Schedules',
    keywords: 'cron schedule recurring timer',
    query: { type: 'cron' },
    find: null,
  },
  {
    id: 'triggers-connector-events',
    section: 'triggers',
    label: 'Connector events',
    keywords: 'event trigger integration event',
    query: { type: 'event' },
    find: null,
  },
  {
    id: 'triggers-app-events',
    section: 'triggers',
    label: 'App events',
    keywords: 'app event trigger',
    query: { type: 'app' },
    find: null,
  },
  {
    id: 'triggers-webhooks',
    section: 'triggers',
    label: 'Webhooks',
    keywords: 'webhook http endpoint incoming',
    query: { type: 'webhook' },
    find: null,
  },

  // Sandbox
  {
    id: 'sandbox-templates',
    section: 'sandbox',
    label: 'Sandbox templates',
    keywords: 'cpu memory processor storage machine size template',
  },
  { id: 'sandbox-build-log', section: 'sandbox', label: 'Build log', keywords: 'snapshot image build logs' },

  // Git
  {
    id: 'git-client',
    section: 'git',
    label: 'Use your own Git client',
    keywords: 'clone git remote push pull ssh https',
  },
  { id: 'git-access', section: 'git', label: 'People with access', keywords: 'collaborators repository access' },
  { id: 'git-local', section: 'git', label: 'Work on this locally', keywords: 'local clone cli checkout' },
  {
    id: 'git-github',
    section: 'git',
    label: 'GitHub connections',
    keywords: 'github app installation connect account',
  },

  // Members: `?invite=1` opens the invite form.
  {
    id: 'members-invite',
    section: 'members',
    label: 'Invite people',
    keywords: 'invite add member teammate email join',
    query: { invite: '1' },
    find: null,
  },

  // Identity: `?accountSetup=` opens a setup wizard.
  {
    id: 'identity-sso',
    section: 'identity',
    label: 'SAML SSO',
    keywords: 'sso saml single sign on okta azure entra google workspace',
  },
  { id: 'identity-domain', section: 'identity', label: 'Domain verification', keywords: 'dns txt verify domain' },
  {
    id: 'identity-scim',
    section: 'identity',
    label: 'Directory Sync',
    keywords: 'scim directory provisioning sync users groups',
  },
  {
    id: 'identity-auto-provision',
    section: 'identity',
    label: 'Auto-provision groups',
    keywords: 'jit provisioning groups sso',
  },

  // Audit log
  { id: 'audit-webhooks', section: 'audit', label: 'Audit webhooks', keywords: 'siem export stream events webhook' },

  // Plan
  { id: 'plan-credits', section: 'plan', label: 'Add credits', keywords: 'top up buy credits balance' },
  { id: 'plan-portal', section: 'plan', label: 'Billing portal', keywords: 'invoices payment method card receipts' },
  {
    id: 'plan-cancel',
    section: 'plan',
    label: 'Cancel subscription',
    keywords: 'downgrade stop subscription',
  },

  // Usage: `?accountTransactions=` picks the tab on load.
  {
    id: 'usage-ledger',
    section: 'usage',
    label: 'Credit ledger',
    keywords: 'transactions credits history ledger',
    query: { accountTransactions: 'credit-ledger' },
    find: null,
  },
  {
    id: 'usage-session-costs',
    section: 'usage',
    label: 'Session costs',
    keywords: 'cost per session spend explorer',
    find: null,
  },

  // Help
  { id: 'help-roles', section: 'help', label: 'Workspace roles', keywords: 'owner admin member permissions' },
  { id: 'help-custom-roles', section: 'help', label: 'Custom roles', keywords: 'permissions roles' },
  { id: 'help-override', section: 'help', label: 'Override rule', keywords: 'deny allow precedence permissions' },
];

/** A section the caller may open: its key, label and where its row links. */
export interface SettingsSearchSection {
  key: string;
  label: string;
  href: string;
}

export interface SettingsSearchResult {
  id: string;
  label: string;
  /** The section this result opens, for the breadcrumb. */
  section: SettingsSearchSection;
  /** Absent: the result is the section row itself. */
  entry?: SettingsSearchEntry;
}

/** The query split into lowercase words; each must match. */
function words(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * How well `label` answers the query: 3 the label starts with it, 2 a word of
 * the label starts with it, 1 the label contains it, 0 only the keywords or
 * the section name match. -1: no match.
 */
function score(query: string, label: string, haystack: string): number {
  const terms = words(query);
  if (terms.length === 0) return -1;
  const text = haystack.toLowerCase();
  if (!terms.every((term) => text.includes(term))) return -1;
  const name = label.toLowerCase();
  const phrase = terms.join(' ');
  if (name.startsWith(phrase)) return 3;
  if (name.split(/[\s-]+/).some((word) => word.startsWith(phrase))) return 2;
  if (name.includes(phrase)) return 1;
  return 0;
}

/**
 * The matches for `query` among `sections` (only the sections the caller may
 * open) and their entries. Best first; ties keep the rail's order.
 */
export function searchSettings(
  query: string,
  sections: readonly SettingsSearchSection[],
  entries: readonly SettingsSearchEntry[] = SETTINGS_SEARCH_ENTRIES,
): SettingsSearchResult[] {
  const byKey = new Map(sections.map((section) => [section.key, section]));
  const ranked: { result: SettingsSearchResult; score: number; order: number }[] = [];
  let order = 0;
  for (const section of sections) {
    const s = score(query, section.label, section.label);
    if (s >= 0) ranked.push({ result: { id: section.key, label: section.label, section }, score: s + 0.5, order });
    order += 1;
  }
  const terms = words(query);
  for (const entry of entries) {
    const section = byKey.get(entry.section);
    if (!section) continue;
    // A word may name the section ("models routing"), but at least one word
    // must name the entry itself: a query that only names the section is
    // answered by the section row, not by every entry inside it.
    const own = `${entry.label} ${entry.keywords ?? ''}`.toLowerCase();
    if (!terms.some((term) => own.includes(term))) {
      order += 1;
      continue;
    }
    const s = score(query, entry.label, `${own} ${section.label}`);
    if (s >= 0) ranked.push({ result: { id: entry.id, label: entry.label, section, entry }, score: s, order });
    order += 1;
  }
  return ranked.sort((a, b) => b.score - a.score || a.order - b.order).map((item) => item.result);
}

/**
 * The results grouped by section, in the order each section first ranks: the
 * section heads its group, and the matches inside it sit under it. A section
 * that did not match by name still heads its group, so every match shows
 * where it lives without repeating the section on each row.
 */
export interface SettingsSearchGroup {
  section: SettingsSearchSection;
  /** The section's own name matched the query. */
  sectionMatched: boolean;
  children: SettingsSearchResult[];
}

export function groupSettingsResults(results: readonly SettingsSearchResult[]): SettingsSearchGroup[] {
  const groups = new Map<string, SettingsSearchGroup>();
  for (const result of results) {
    let group = groups.get(result.section.key);
    if (!group) {
      group = { section: result.section, sectionMatched: false, children: [] };
      groups.set(result.section.key, group);
    }
    if (result.entry) group.children.push(result);
    else group.sectionMatched = true;
  }
  return [...groups.values()];
}

/** Where a result goes: its section, with the entry's params. */
export function settingsSearchHref(result: SettingsSearchResult): string {
  const query = result.entry?.query;
  if (!query) return result.section.href;
  const [path, existing = ''] = result.section.href.split('?');
  const params = new URLSearchParams(existing);
  for (const [key, value] of Object.entries(query)) params.set(key, value);
  return `${path}?${params.toString()}`;
}
