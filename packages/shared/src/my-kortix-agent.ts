/** Xera (internal compatibility slug `mykortix`), the platform's
 *  centralized agent: session rows, token grants, sandbox slug, image names
 *  and config-release variant key on it. */
export const DOT_AGENT_NAME = 'dot';
export const MY_KORTIX_AGENT_NAME = 'mykortix';
/** The slug Xera had until 2026-10-30. Sessions, tokens and boxes made
 *  before the rename still carry it, so every read accepts it
 *  ({@link isMyKortixAgentName}); nothing new writes it. Drop it when no
 *  session or box from before the rename is live. */
export const LEGACY_MY_KORTIX_AGENT_NAME = 'meta';
export const MY_KORTIX_SANDBOX_SLUG = 'mykortix';
/** Xera — the centralized coordinator agent's DISPLAY name rendered in the UI. */
export const MY_KORTIX_DISPLAY_NAME = 'Xera';

/** True for Xera under its canonical slug `mykortix`, `xera`, `dot`, `kortix`, or legacy `meta`. */
/**
 * How a person reads a session's message handle: Xera's own session has
 * the generated handle `xera-<short id>`, `dot-<short id>`, `mykortix-<short id>`, or legacy `meta-…`,
 * shown as "Xera"; a named agent shows as `@name`.
 */
export function peerHandleLabel(handle: string): string {
  return /^(dot|xera|mykortix|meta)-[0-9a-f]{8}$/.test(handle) ? MY_KORTIX_DISPLAY_NAME : `@${handle}`;
}

export function isMyKortixAgentName(name: string | null | undefined): boolean {
  if (!name) return false;
  const n = String(name).toLowerCase().trim();
  return (
    n === MY_KORTIX_AGENT_NAME ||
    n === LEGACY_MY_KORTIX_AGENT_NAME ||
    n === DOT_AGENT_NAME ||
    n === 'kortix' ||
    n === 'xera'
  );
}

/** True for Dot's sandbox slug, or the legacy `meta` slug of an older box. */
export function isMyKortixSandboxSlug(slug: string | null | undefined): boolean {
  return slug === MY_KORTIX_SANDBOX_SLUG || slug === LEGACY_MY_KORTIX_AGENT_NAME || slug === DOT_AGENT_NAME;
}

/** The current slug for a name: `meta` and `dot` map to `mykortix` internally, any other name stays. */
export function canonicalAgentName<T extends string | null | undefined>(name: T): T | typeof MY_KORTIX_AGENT_NAME {
  return name === LEGACY_MY_KORTIX_AGENT_NAME || name === DOT_AGENT_NAME ? MY_KORTIX_AGENT_NAME : name;
}

/**
 * The built-in agents a project can turn on or off in `kortix.yaml`
 * (`builtin_agents.<key>: true|false`, absent = off). Each key maps once to the
 * agent slug the platform injects. Add a built-in here, nowhere else.
 */
export const BUILTIN_AGENTS = {
  my_kortix: { agent: MY_KORTIX_AGENT_NAME, displayName: MY_KORTIX_DISPLAY_NAME, sandbox: MY_KORTIX_SANDBOX_SLUG },
} as const;
export type BuiltinAgentKey = keyof typeof BUILTIN_AGENTS;
export const BUILTIN_AGENT_KEYS = Object.keys(BUILTIN_AGENTS) as BuiltinAgentKey[];

/** The `builtin_agents` key of a built-in agent slug (legacy `meta` included), or `null` for a declared agent. */
export function builtinAgentKeyOf(agentName: string | null | undefined): BuiltinAgentKey | null {
  if (!agentName) return null;
  const name = canonicalAgentName(agentName);
  return BUILTIN_AGENT_KEYS.find((key) => BUILTIN_AGENTS[key].agent === name) ?? null;
}

/**
/**
 * An agent's name as a person reads it: Xera for the built-in coordinator,
 * then its `kortix.yaml` `title` as written ("GitHub PR reviewer"), otherwise
 * the manifest key in sentence case with its separators as spaces
 * (`worker` → "Worker", `session-reviewer` → "Session reviewer"). One helper,
 * so the web app, the sidebar and channel posts (Slack) name an agent the same way.
 * Pass `title` wherever the agent record is in hand; a bare slug keeps the derived name.
 */
export function agentDisplayName(slug: string, title?: string | null): string {
  if (isMyKortixAgentName(slug) || isMyKortixAgentName(title)) return MY_KORTIX_DISPLAY_NAME;
  if (typeof title === 'string' && title.trim()) {
    if (/^(kortix|my\s*kortix|dot)$/i.test(title.trim())) return MY_KORTIX_DISPLAY_NAME;
    return title.trim();
  }
  if (typeof slug !== 'string') return String(slug);
  if (slug === 'worker') return 'Worker';
  if (/^(kortix|my\s*kortix|dot)$/i.test(slug.trim())) return MY_KORTIX_DISPLAY_NAME;
  const words = slug.replace(/[-_]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
