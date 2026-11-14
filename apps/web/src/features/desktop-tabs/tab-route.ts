/**
 * What a tab shows for a path: which kind of page it is and the id the title
 * resolver needs. Pure, so the strip and its tests agree on every route.
 *
 * Only paths inside the project the strip belongs to are tabs. A path in
 * another project or outside `/workspaces/<id>` returns null and the strip
 * ignores it.
 */
export type TabRoute =
  | { kind: 'home' }
  | { kind: 'session'; sessionId: string }
  | { kind: 'sessions' }
  | { kind: 'artifact'; artifactId: string }
  | { kind: 'artifacts' }
  | { kind: 'agent'; name: string }
  | { kind: 'admin'; section: string | null }
  | { kind: 'customize'; section: string | null }
  | { kind: 'goal'; goalId: string }
  | { kind: 'channel'; slug: string }
  | { kind: 'dm'; agent: string }
  | { kind: 'space'; slug: string }
  | { kind: 'settings' }
  /** The Apps page with one App open (`?app=`). */
  | { kind: 'app'; appId: string }
  /**
   * A project page this table does not name yet. It still gets a tab (one per
   * first segment, titled "Page"), so a new route never leaves the strip on
   * the tab you came from. `tab-route.test.ts` fails until it is named.
   */
  | { kind: 'section'; name: string }
  | {
      kind: 'page';
      page:
        | 'apps'
        | 'chat'
        | 'drive'
        | 'files'
        | 'goals'
        | 'inbox'
        | 'memory'
        | 'members';
    };

const PAGES = new Set([
  'apps',
  'chat',
  'drive',
  'files',
  'goals',
  'inbox',
  'memory',
  'members',
]);

// A real app path is percent-encoded; a raw control character (a newline)
// only appears in a tampered stored value.
const CONTROL_CHAR = /[\u0000-\u001f\u007f]/;
const DOT_SEGMENT = /^(?:\.|%2e){1,2}$/i;

function decode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** The project-relative segments of `path`, or null when it is not in `projectId`. */
function projectSegments(path: string, projectId: string): string[] | null {
  // An app path only: `/workspaces/...`, never `//host` or `https://host`.
  if (!path.startsWith('/') || path.startsWith('//')) return null;
  const pathname = path.split(/[?#]/)[0] ?? '';
  // A path the browser would resolve somewhere else than the segments read
  // below: a backslash (a separator to the URL parser) or a dot segment,
  // plain or encoded (`..`, `%2e%2e`). Raw spaces and Unicode stay valid.
  if (pathname.includes('\\') || CONTROL_CHAR.test(path)) return null;
  if (pathname.split('/').some((segment) => DOT_SEGMENT.test(segment))) return null;
  const parts = pathname.split('/').filter(Boolean);
  if (parts[0] !== 'workspaces' && parts[0] !== 'projects') return null;
  if (parts[1] !== projectId) return null;
  return parts.slice(2);
}

export function tabRoute(path: string, projectId: string): TabRoute | null {
  const seg = projectSegments(path, projectId);
  if (!seg) return null;
  const [a, b, c] = seg;
  if (!a) return { kind: 'home' };
  switch (a) {
    case 'sessions':
      return b ? { kind: 'session', sessionId: b } : { kind: 'sessions' };
    case 'artifacts':
      return b ? { kind: 'artifact', artifactId: b } : { kind: 'artifacts' };
    case 'admin':
      if (b === 'agents' && c) return { kind: 'agent', name: decode(c) };
      return { kind: 'admin', section: b ?? null };
    case 'customize':
      return { kind: 'customize', section: b ?? null };
    case 'goals':
      return b ? { kind: 'goal', goalId: b } : { kind: 'page', page: 'goals' };
    case 'c':
      return b ? { kind: 'channel', slug: decode(b) } : { kind: 'page', page: 'chat' };
    case 'dm':
      return b ? { kind: 'dm', agent: decode(b) } : { kind: 'page', page: 'chat' };
    case 'spaces':
      return b ? { kind: 'space', slug: decode(b) } : { kind: 'home' };
    case 'settings':
      return { kind: 'settings' };
    // Old addresses that redirect into Customize. They resolve to the section
    // they land on, so the redirect stays in the Customize tab instead of
    // leaving a tab behind for an address nobody sees.
    case 'evals':
      return { kind: 'admin', section: b === 'jobs' ? 'eval-jobs' : 'evals' };
    case 'reminders':
      return { kind: 'admin', section: 'reminders' };
    case 'channels':
      return { kind: 'admin', section: 'connectors' };
    case 'apps': {
      const appId = new URLSearchParams(path.split('?')[1]?.split('#')[0] ?? '').get('app');
      return appId ? { kind: 'app', appId } : { kind: 'page', page: 'apps' };
    }
    default:
      if (PAGES.has(a))
        return { kind: 'page', page: a as Extract<TabRoute, { kind: 'page' }>['page'] };
      return { kind: 'section', name: a };
  }
}

/**
 * The destination a path belongs to, which decides the tab it opens in.
 *
 * A session, an artifact and a Workspace settings section are documents: each
 * has its own tab, and a plain click on one opens it in the tab you are
 * browsing in (`syncPath`). A page below a settings section (one agent, one
 * connector, one eval job) belongs to that section's tab. Every other page
 * belongs to its area (Goals and one goal, Apps and one App), one tab each.
 */
export function tabGroup(route: TabRoute): string {
  switch (route.kind) {
    case 'home':
      return HOME_GROUP;
    case 'session':
      return `${SESSION_GROUP}${route.sessionId}`;
    case 'artifact':
      return `artifact:${route.artifactId}`;
    case 'artifacts':
      return 'artifacts';
    case 'agent':
      return `${SETTINGS_GROUP}agents`;
    case 'admin':
    case 'customize':
      return `${SETTINGS_GROUP}${settingsSection(route.section)}`;
    case 'settings':
      return `${SETTINGS_GROUP}general`;
    case 'goal':
      return 'goals';
    case 'channel':
    case 'dm':
      return 'chat';
    case 'space':
      return `space:${route.slug}`;
    case 'sessions':
      return 'sessions';
    // The Apps tab shows the grid or one open App; both are that one tab.
    case 'app':
      return 'apps';
    case 'page':
      return route.page;
    case 'section':
      return `section:${route.name}`;
  }
}

/** The settings section a URL segment belongs to: the eval pages are one section. */
function settingsSection(section: string | null): string {
  if (!section) return '';
  return section.startsWith('eval') ? 'evals' : section;
}

/** The project's home: a blank New session, which the next destination replaces. */
export const HOME_GROUP = 'home';
const SESSION_GROUP = 'session:';
const SETTINGS_GROUP = 'customize:';

export function isSessionGroup(group: string | null): boolean {
  return !!group && group.startsWith(SESSION_GROUP);
}

/** A Workspace settings section (Customize): Agents, Skills, Security, … */
export function isSettingsGroup(group: string | null): boolean {
  return !!group && group.startsWith(SETTINGS_GROUP);
}

/** `tabGroup` for a path, or null when the path is not a page of the project. */
export function pathGroup(path: string, projectId: string): string | null {
  const route = tabRoute(path, projectId);
  return route ? tabGroup(route) : null;
}

/**
 * Whether the strip shows: always, except on a fresh start (one blank New
 * session tab), which has nothing to switch between. The first page you open
 * becomes that tab and the strip appears. `currentPath` counts too: the window
 * can be on a page before the store has caught up.
 */
export function stripVisible(
  tabs: readonly { path: string }[],
  currentPath: string,
  projectId: string,
): boolean {
  if (tabs.length > 1) return true;
  const isPage = (path: string) => {
    const group = pathGroup(path, projectId);
    return group !== null && group !== HOME_GROUP;
  };
  return isPage(currentPath) || tabs.some((tab) => isPage(tab.path));
}

/**
 * A document destination: one session, one artifact or one settings section.
 * A plain click on one opens it in the tab you are browsing in (`syncPath`),
 * so clicking through a list does not pile up tabs.
 */
export function isDocumentGroup(group: string | null): boolean {
  return (
    !!group &&
    (group.startsWith(SESSION_GROUP) ||
      group.startsWith('artifact:') ||
      group.startsWith(SETTINGS_GROUP))
  );
}

/** The path a new tab opens on: the project's home, where a new session starts. */
export function newTabPath(projectId: string): string {
  return `/workspaces/${projectId}`;
}

/**
 * `map[key]` for the map's OWN keys only. A section comes from the URL, so a
 * plain lookup of `/admin/constructor` returned `Object.prototype.constructor`
 * and the strip rendered a function as an icon.
 */
export function ownEntry<V>(
  map: Readonly<Record<string, V>>,
  key: string | null | undefined,
): V | undefined {
  return key != null && Object.hasOwn(map, key) ? map[key] : undefined;
}

/** A key that is a property of every object (`constructor`, `toString`, `__proto__`, …). */
export function isPrototypeKey(key: string): boolean {
  return key in Object.prototype || key === '__proto__';
}
