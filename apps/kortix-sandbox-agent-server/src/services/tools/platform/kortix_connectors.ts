/**
 * kortix_connectors: outside apps the project's agents may use (Gmail, Google
 * Drive, Notion, a CRM…). List what is installed, find an app, add it, and get
 * the sign-in link the person clicks. Which agent may use which connector is
 * `kortix_agents` `set_access`. A My Kortix platform tool (`platform.ts`):
 * every action is one `kortix connectors …` command.
 */
import { adminHref, capRows, cliJson, cliRun, fail, ok, cliArgProblem, type PlatformToolContext } from './platform'

const TOOL = 'kortix_connectors' as const
const ACTIONS = ['list', 'find', 'add', 'connect'] as const

interface Profile {
  slug?: string
  name?: string | null
  display_name?: string | null
  provider?: string | null
  status?: string | null
  connected?: boolean
  accounts?: unknown[]
}

interface CatalogRow {
  id?: string
  name?: string | null
  description?: string | null
  installed_as?: string | null
  installed?: string | null
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
  const profiles = rowsOf<Profile>(read.value, 'profiles')
  return ok(
    TOOL,
    'list',
    {
      title: profiles.length === 1 ? '1 connector' : `${profiles.length} connectors`,
      rows: capRows(
        profiles.map((profile) => {
          const signedIn = profile.connected === true || (Array.isArray(profile.accounts) && profile.accounts.length > 0)
          return {
            title: profile.display_name || profile.name || profile.slug || 'connector',
            ...(profile.slug ? { detail: profile.slug } : {}),
            badge: profile.status || (signedIn ? 'connected' : 'not signed in'),
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
        const installed = app.installed_as || app.installed
        return {
          title: app.name || app.id || 'app',
          ...(app.description ? { detail: app.description } : {}),
          ...(installed ? { badge: 'added' } : {}),
        }
      }),
    },
    read.value,
  )
}

async function add(app: string, context: PlatformToolContext) {
  const made = await cliJson<Record<string, unknown>>(['connectors', 'catalog', 'install', app, '--json'], context)
  if ('error' in made) {
    // Exit 3: the app is already installed. That is the person's goal, not a failure.
    if (made.error.message.includes('already installed')) return ok(TOOL, 'add', { title: `${app} is already added` })
    return fail(TOOL, 'add', `Could not add ${app}`, made.error, context)
  }
  const slug = typeof made.value.slug === 'string' ? made.value.slug : app
  return ok(
    TOOL,
    'add',
    { title: `Added ${slug}`, subtitle: 'Next: sign in, so agents can use it.', links: [{ label: 'Connectors', href: adminHref(context.env, 'connectors') }] },
    made.value,
  )
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
    '`find` (query: search every app Kortix can connect); `add` (app: an id from find); ' +
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
      shared: { type: 'boolean', description: 'For connect: share the sign-in with the whole workspace. Default: only this person, or shared when for_trigger is true.' },
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
