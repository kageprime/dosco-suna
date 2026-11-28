/**
 * kortix_connectors: outside apps the project's agents may use (Gmail, Google
 * Drive, Notion, a CRM…). List what is installed, find an app, add it, and get
 * the sign-in link the person clicks. Which agent may use which connector is
 * `kortix_agents` `set_access`. A My Kortix platform tool (`platform.ts`):
 * every action is one `kortix connectors …` command.
 */
import { adminHref, capRows, cliJson, cliRun, fail, ok, cliArgProblem, cliError, parseJson, runKortix, type PlatformToolContext } from './platform'

const TOOL = 'kortix_connectors' as const
const ACTIONS = ['list', 'find', 'add', 'connect'] as const

/** One row of `kortix connectors ls --json` (`{ connectors: [...] }`, the API's connector list). */
interface ListedConnector {
  slug?: string
  name?: string | null
  display_name?: string | null
  state?: 'disabled' | 'error' | 'needs_account' | 'connected' | null
  state_reason?: string | null
  accounts?: unknown[]
}

const STATE_WORDS: Record<string, string> = { connected: 'connected', needs_account: 'not signed in', disabled: 'disabled' }

interface CatalogRow {
  id?: string
  name?: string | null
  description?: string | null
  /** What a sign-in lets agents do, in plain words; only for apps whose scopes Kortix knows. */
  access?: string | null
  installed_as?: string | null
  /** The slugs this app is installed as; `[]` when it is not. */
  installed?: string[] | string | null
}

function rowsOf<T>(value: unknown, key: string): T[] {
  if (Array.isArray(value)) return value as T[]
  const record = (value ?? {}) as Record<string, unknown>
  const list = record[key] ?? record.items ?? record.rows ?? record.data
  return Array.isArray(list) ? (list as T[]) : []
}

async function list(context: PlatformToolContext) {
  const read = await cliJson(['connectors', 'ls', '--json'], context)
  if ('error' in read) return fail(TOOL, 'list', 'Could not list the connectors', read.error, context)
  const connectors = rowsOf<ListedConnector>(read.value, 'connectors')
  return ok(
    TOOL,
    'list',
    {
      title: connectors.length === 1 ? '1 connector' : `${connectors.length} connectors`,
      rows: capRows(
        connectors.map((connector) => {
          const signedIn = Array.isArray(connector.accounts) && connector.accounts.length > 0
          const state = connector.state ?? (signedIn ? 'connected' : 'needs_account')
          return {
            title: connector.display_name || connector.name || connector.slug || 'connector',
            ...(connector.slug ? { detail: connector.slug } : {}),
            badge: STATE_WORDS[state] ?? (connector.state_reason ? `${state}: ${connector.state_reason}` : state),
          }
        }),
      ),
      links: [{ label: 'Connectors', href: adminHref(context.env, 'connectors') }],
    },
    read.value,
  )
}

async function find(query: string, context: PlatformToolContext) {
  const read = await cliJson(['connectors', 'catalog', query, '--limit', '8', '--json'], context)
  if ('error' in read) return fail(TOOL, 'find', `Could not search for ${query}`, read.error, context)
  const apps = rowsOf<CatalogRow>(read.value, 'apps')
  return ok(
    TOOL,
    'find',
    {
      title: apps.length === 0 ? `No app matches "${query}"` : `${apps.length} ${apps.length === 1 ? 'app' : 'apps'} for "${query}"`,
      rows: apps.map((app) => {
        const installed = app.installed_as || (Array.isArray(app.installed) ? app.installed.length > 0 : app.installed)
        return {
          title: app.name || app.id || 'app',
          ...(app.description || app.access ? { detail: [app.description, app.access ? `Signing in lets agents: ${app.access}` : null].filter(Boolean).join(' ') } : {}),
          ...(installed ? { badge: 'added' } : {}),
        }
      }),
    },
    read.value,
  )
}

async function add(app: string, context: PlatformToolContext) {
  const run = await runKortix(['connectors', 'catalog', 'install', app, '--json'], context)
  const value = run.code === 0 || run.code === 3 ? parseJson<Record<string, unknown>>(run.stdout) : null
  // Exit 3 with the install's JSON: the app is already installed. That is the person's goal, not a failure.
  if (run.code === 3 && value?.existing) {
    const slug = typeof value.slug === 'string' ? value.slug : app
    return ok(TOOL, 'add', { title: `${slug} is already added`, subtitle: nextStep(value), links: [{ label: 'Connectors', href: adminHref(context.env, 'connectors') }] }, value)
  }
  if (run.code !== 0 || !value) return fail(TOOL, 'add', `Could not add ${app}`, run.code !== 0 ? cliError(run) : { kind: 'failed', message: 'The command answered with no JSON.' }, context)
  const made = { value }
  const slug = typeof made.value.slug === 'string' ? made.value.slug : app
  return ok(
    TOOL,
    'add',
    { title: `Added ${slug}`, subtitle: nextStep(made.value), links: [{ label: 'Connectors', href: adminHref(context.env, 'connectors') }] },
    made.value,
  )
}

/** What the install says comes next (`next` of `kortix connectors catalog install --json`). */
function nextStep(installed: Record<string, unknown>): string {
  if (installed.next === 'ready') return 'Ready: it needs no sign-in.'
  if (installed.next === 'credential') return 'Next: it needs a key. Ask for it with a secret link, never in chat.'
  if (installed.next === 'fix') return `It does not work yet${typeof installed.error === 'string' ? `: ${installed.error}` : ''}.`
  return 'Next: sign in, so agents can use it.'
}

/**
 * Whose sign-in a connect link makes. A trigger or automation runs only on the
 * workspace's shared account, so `for_trigger` means shared: one card, never a
 * private card first and a shared one after it (an e2e run on dev got both).
 * A person who may not share gets the refusal and who can grant it, not a
 * private sign-in the trigger could never use.
 */
async function connect(slug: string, shared: boolean, forTrigger: boolean, context: PlatformToolContext) {
  const started = await cliRun(['connectors', 'connect', slug, '--owner', shared ? 'project' : 'me'], context)
  if ('error' in started) {
    // The API answers 404 for a slug the workspace has not added; say how to add it.
    if (started.error.kind === 'not_found') {
      return fail(TOOL, 'connect', `${slug} is not added yet`, { kind: 'not_found', message: `No connector "${slug}" in this workspace. Add it first (find, then add with the app id find returns, e.g. kortix:${slug}), then connect.` }, context)
    }
    const title = forTrigger ? `A workspace manager must sign in to ${slug} for triggers` : `Could not start the sign-in for ${slug}`
    return fail(TOOL, 'connect', title, started.error, context)
  }
  const url = started.text.match(/https?:\/\/\S+/)?.[0]
  if (!url) return ok(TOOL, 'connect', { title: `${slug} is ready`, subtitle: 'It needs no sign-in.' }, { slug, ready: true })
  return ok(
    TOOL,
    'connect',
    {
      title: `Sign in to ${slug}`,
      subtitle: !shared
        ? 'Only you will use this sign-in.'
        : forTrigger
          ? 'Everyone in the workspace will use this sign-in, so triggers can run on it.'
          : 'Everyone in the workspace will use this sign-in.',
      status: 'needs_you',
      links: [{ label: 'Sign in', href: url }],
    },
    { slug, url },
  )
}

export default {
  description:
    'Outside apps agents may use (Gmail, Google Drive, Notion, Slack, a CRM…). Actions: `list` (what is added and signed in); ' +
    '`find` (query: search every app Kortix can connect; an app\'s `access` says what its sign-in lets agents do: name it, word for word, before the person says yes, and for an app with no `access` say its sign-in page lists what it asks for, never guess); `add` (app: an id from find); ' +
    '`connect` (slug: get the sign-in link for the person; shared=true makes the sign-in the whole workspace\'s; ' +
    'for_trigger=true when the sign-in is for a trigger, wake-up or other automation: those run only on the shared sign-in, so it mints that one). ' +
    'Mint ONE link per app and end the turn: never a private link first and a shared one after it. ' +
    'Never ask for a password: the person signs in through the link. To let an agent use a connector, use kortix_agents set_access.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: [...ACTIONS], description: 'What to do.' },
      query: { type: 'string', description: 'For find: the app to look for.' },
      app: { type: 'string', description: 'For add: the app id find returned.' },
      slug: { type: 'string', description: 'For connect: the connector slug list shows.' },
      shared: { type: 'boolean', description: 'For connect: share the sign-in with the whole workspace. Pass true when the person asks for it "for the workspace" or "for the team". Default: only this person, or shared when for_trigger is true.' },
      for_trigger: { type: 'boolean', description: 'For connect: the sign-in is for a trigger, wake-up or automation. It is then the workspace\'s shared sign-in.' },
    },
    required: ['action'],
  },
  async execute(args: Record<string, any>, context: PlatformToolContext) {
    const action = String(args.action ?? '')
    const text = (key: string) => (typeof args[key] === 'string' ? args[key].trim() : '')
    if (action === 'list') return list(context)
    const field = action === 'find' ? 'query' : action === 'add' ? 'app' : 'slug'
    const bad = text(field) ? cliArgProblem(field, text(field), action === 'find' ? 'text' : 'word') : null
    if (bad) return fail(TOOL, action, 'Which app?', { kind: 'invalid', message: bad }, context)
    if (action === 'find') return text('query') ? find(text('query'), context) : fail(TOOL, action, 'Which app?', { kind: 'invalid', message: 'Pass query.' }, context)
    if (action === 'add') return text('app') ? add(text('app'), context) : fail(TOOL, action, 'Which app?', { kind: 'invalid', message: 'Pass app, an id from find.' }, context)
    if (action === 'connect') return text('slug') ? connect(text('slug'), args.shared === true || (args.for_trigger === true && args.shared !== false), args.for_trigger === true, context) : fail(TOOL, action, 'Which connector?', { kind: 'invalid', message: 'Pass slug.' }, context)
    return fail(TOOL, action, 'Unknown action', { kind: 'invalid', message: `Use one of: ${ACTIONS.join(', ')}.` }, context)
  },
}
