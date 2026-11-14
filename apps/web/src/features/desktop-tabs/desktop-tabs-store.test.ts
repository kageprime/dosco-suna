import { describe, expect, test } from 'bun:test';

import {
  closeOthers,
  closeTab,
  closeToRight,
  keepTab,
  MAX_TABS,
  openBlankTab,
  openTab,
  reopenClosed,
  reorder,
  sanitizePersisted,
  setPinned,
  settle,
  syncPath,
  type ProjectTabs,
} from './desktop-tabs-store';
import { isPrototypeKey, ownEntry, pathGroup, stripVisible, tabRoute } from './tab-route';

const P = 'project-1';
const home = `/workspaces/${P}`;
const s1 = `/workspaces/${P}/sessions/s1`;
const s2 = `/workspaces/${P}/sessions/s2`;
const models = `/workspaces/${P}/admin/models`;

const g = (path: string) => pathGroup(path, P);
const empty: ProjectTabs = { tabs: [], activeId: null, closed: [] };
const s1Path = (i: number) => `${home}/sessions/x${i}`;
const paths = (s: ProjectTabs) => s.tabs.map((t) => t.path);
const activePath = (s: ProjectTabs) => s.tabs.find((t) => t.id === s.activeId)?.path;

// Every change goes through `settle`, as the store's `update` does.
const via = (prev: ProjectTabs, next: ProjectTabs) => settle(prev, next);
const nav = (s: ProjectTabs, path: string, replaced = false) =>
  via(s, syncPath(s, path, g, replaced));
const focus = (s: ProjectTabs, path: string) =>
  via(s, { ...s, activeId: s.tabs.find((t) => t.path === path)!.id });
const previews = (s: ProjectTabs) => s.tabs.filter((t) => t.preview).map((t) => t.path);

describe('desktop tabs: navigation', () => {
  const goals = `${home}/goals`;
  const goal = `${home}/goals/g1`;
  const s3 = `${home}/sessions/s3`;
  const a1 = `${home}/artifacts/a1`;
  const a2 = `${home}/artifacts/a2`;

  test('the first navigation opens the first tab', () => {
    const s = nav(empty, s1);
    expect(paths(s)).toEqual([s1]);
    expect(activePath(s)).toBe(s1);
    expect(previews(s)).toEqual([]);
  });

  test('a page opened from a session gets its own tab; the session stays', () => {
    let s = nav(empty, s1);
    s = nav(s, goals);
    expect(paths(s)).toEqual([s1, goals]);
    expect(activePath(s)).toBe(goals);
  });

  test('moving inside an area stays in its tab (Goals → one goal)', () => {
    let s = nav(empty, s1);
    s = nav(s, goals);
    s = nav(s, goal);
    expect(paths(s)).toEqual([s1, goal]);
  });

  test('a destination with a tab focuses that tab and moves it there', () => {
    let s = nav(empty, s1);
    s = nav(s, goals);
    s = nav(s, s1);
    s = nav(s, goal);
    expect(paths(s)).toEqual([s1, goal]);
    expect(activePath(s)).toBe(goal);
  });

  test('clicking through sessions reuses the tab you are browsing in', () => {
    let s = nav(empty, s1);
    for (const id of ['s2', 's3', 's4']) s = nav(s, `${home}/sessions/${id}`);
    expect(paths(s)).toEqual([s1, `${home}/sessions/s4`]);
    expect(previews(s)).toEqual([`${home}/sessions/s4`]);
  });

  test('a tab you switch away from stays: the next click opens beside it', () => {
    let s = nav(empty, s1);
    s = nav(s, a1);
    expect(previews(s)).toEqual([a1]);
    s = focus(s, s1);
    expect(previews(s)).toEqual([]);
    s = nav(s, a2);
    expect(paths(s)).toEqual([s1, a2, a1]);
    expect(previews(s)).toEqual([a2]);
  });

  test('working in a preview or pinning it keeps it', () => {
    let s = nav(empty, s1);
    s = nav(s, s2);
    s = via(s, keepTab(s, s.activeId));
    s = nav(s, s3);
    expect(paths(s)).toEqual([s1, s2, s3]);
    s = via(s, setPinned(s, s.activeId!, true));
    expect(previews(s)).toEqual([]);
    s = nav(s, `${home}/sessions/s4`);
    expect(paths(s)).toContain(s3);
  });

  test('an App opened from a session opens in the Apps tab, not over the session', () => {
    const app = `${home}/apps?app=x1`;
    let s = nav(empty, s1);
    s = nav(s, app);
    expect(paths(s)).toEqual([s1, app]);
    expect(previews(s)).toEqual([]);
  });

  test('the first session, started in the blank tab, is a normal tab', () => {
    let s = nav(empty, home);
    s = nav(s, s1);
    expect(paths(s)).toEqual([s1]);
    expect(previews(s)).toEqual([]);
  });

  test('a closed preview reopens as a normal tab', () => {
    let s = nav(empty, s1);
    s = nav(s, s2);
    s = via(s, closeTab(s, s.activeId!).state);
    s = via(s, reopenClosed(s));
    expect(previews(s)).toEqual([]);
  });

  test('from a blank tab, a session that already has a tab is focused, not opened twice', () => {
    let s = nav(empty, s1);
    s = via(s, openBlankTab(s, home, g));
    s = nav(s, s1);
    expect(paths(s)).toEqual([s1, home]);
    expect(activePath(s)).toBe(s1);
  });

  test('only one blank tab: + focuses the open one', () => {
    let s = via(empty, openBlankTab(empty, home, g));
    s = nav(s, s1);
    s = via(s, openBlankTab(s, home, g));
    const blank = s.activeId;
    s = via(s, openBlankTab(s, home, g));
    expect(s.tabs).toHaveLength(2);
    expect(s.activeId).toBe(blank);
    s = nav(s, goals);
    s = via(s, openBlankTab(s, home, g));
    expect(activePath(s)).toBe(home);
    expect(s.tabs).toHaveLength(3);
  });

  test('the same path twice is a no-op (same object)', () => {
    const s = nav(empty, s1);
    expect(syncPath(s, s1, g)).toBe(s);
  });

  test('a path outside the project changes nothing', () => {
    const s = nav(empty, s1);
    expect(syncPath(s, '/settings', g)).toBe(s);
  });
});

describe('desktop tabs: fresh start', () => {
  test('the first page you open takes the blank tab; the next one opens a tab', () => {
    let s = nav(empty, home);
    s = nav(s, `${home}/goals`);
    expect(paths(s)).toEqual([`${home}/goals`]);
    s = nav(s, `${home}/drive`);
    expect(paths(s)).toEqual([`${home}/goals`, `${home}/drive`]);
    s = nav(s, `${home}/apps`);
    s = nav(s, `${home}/artifacts`);
    expect(paths(s)).toEqual([`${home}/goals`, `${home}/drive`, `${home}/apps`, `${home}/artifacts`]);
  });

  test('settings from a fresh start: the first section takes the blank tab', () => {
    let s = nav(empty, home);
    s = nav(s, models);
    expect(paths(s)).toEqual([models]);
    s = nav(s, `${home}/drive`);
    expect(paths(s)).toEqual([models, `${home}/drive`]);
  });
});

describe('desktop tabs: Workspace settings (Customize)', () => {
  const agents = `${home}/admin/agents`;
  const agent = `${home}/admin/agents/kortix`;
  const skills = `${home}/admin/skills`;
  const security = `${home}/admin/security`;
  const secrets = `${home}/admin/secrets`;
  const flags = `${home}/admin/feature-flags`;
  const a1 = `${home}/artifacts/a1`;

  test('clicking through the rail reuses one tab', () => {
    let s = nav(empty, s1);
    for (const to of [agents, skills, security, flags]) s = nav(s, to);
    expect(paths(s)).toEqual([s1, flags]);
    expect(previews(s)).toEqual([flags]);
  });

  test('Secrets open in a tab, another tab selected, Security clicked: both stay', () => {
    let s = nav(empty, s1);
    s = nav(s, a1);
    s = via(s, keepTab(s, s.activeId));
    s = nav(s, secrets);
    // Select the artifact tab, then go to Security.
    s = focus(s, a1);
    s = nav(s, security);
    expect(paths(s)).toEqual([s1, a1, security, secrets]);
    expect(activePath(s)).toBe(security);
    expect(previews(s)).toEqual([security]);
  });

  test('a section you worked in stays; the next rail click opens beside it', () => {
    let s = nav(empty, s1);
    s = nav(s, security);
    s = via(s, keepTab(s, s.activeId));
    s = nav(s, skills);
    expect(paths(s)).toEqual([s1, security, skills]);
    expect(previews(s)).toEqual([skills]);
  });

  test('a section that has a tab is focused, never opened twice or rewritten', () => {
    let s = nav(empty, s1);
    s = nav(s, security);
    s = via(s, keepTab(s, s.activeId));
    s = nav(s, skills);
    s = nav(s, security);
    expect(paths(s)).toEqual([s1, security, skills]);
    expect(activePath(s)).toBe(security);
  });

  test('one agent opens in the Agents tab; a second Agents tab never steals it', () => {
    let s = nav(empty, s1);
    s = nav(s, agents);
    s = nav(s, agent);
    expect(paths(s)).toEqual([s1, agent]);
    s = via(s, openTab(s, agents)); // Duplicate
    const clicked = s.activeId;
    s = nav(s, agent);
    expect(s.activeId).toBe(clicked);
  });

  test('Back to the session keeps the settings tab; closing it returns to the session', () => {
    let s = nav(empty, s1);
    s = nav(s, goals);
    s = focus(s, s1);
    s = nav(s, skills);
    expect(paths(s)).toEqual([s1, skills, goals]);
    // Back (the rail's link to the last page outside settings).
    s = nav(s, s1);
    expect(paths(s)).toEqual([s1, skills, goals]);
    expect(previews(s)).toEqual([]);
    // Close settings: back to the session, not to the right neighbour.
    s = focus(s, skills);
    const closed = closeTab(s, s.activeId!);
    expect(closed.navigateTo).toBe(s1);
  });

  test('a redirect stays in its tab (/admin → the section that opened)', () => {
    let s = nav(empty, s1);
    s = nav(s, `${home}/admin`);
    s = nav(s, `${home}/admin/general`, true);
    expect(paths(s)).toEqual([s1, `${home}/admin/general`]);
  });

  test('a redirect to a section that has a tab closes the tab it left', () => {
    let s = nav(empty, s1);
    s = nav(s, security);
    s = focus(s, s1);
    s = nav(s, `${home}/admin/evals`);
    s = nav(s, security, true);
    expect(paths(s)).toEqual([s1, security]);
    expect(activePath(s)).toBe(security);
    expect(s.closed).toEqual([]);
  });

  const goals = `${home}/goals`;
});

describe('desktop tabs: settle', () => {
  test('only the active tab is ever a preview', () => {
    let s = nav(empty, s1);
    s = nav(s, s2);
    s = via(s, openTab(s, home));
    expect(previews(s)).toEqual([]);
  });

  test('closing goes back through the tabs in the order they were in front', () => {
    let s = nav(empty, s1);
    s = nav(s, `${home}/goals`);
    s = nav(s, `${home}/drive`);
    s = focus(s, s1);
    s = focus(s, `${home}/drive`);
    let closed = closeTab(s, s.activeId!);
    expect(closed.navigateTo).toBe(s1);
    s = via(s, closed.state);
    closed = closeTab(s, s.activeId!);
    expect(closed.navigateTo).toBe(`${home}/goals`);
  });

  test('no change returns the same object', () => {
    const s = nav(empty, s1);
    expect(settle(s, s)).toBe(s);
    expect(settle(s, { ...s })).toEqual(s);
  });
});

describe('desktop tabs: when the strip shows', () => {
  const tab = (path: string) => ({ id: path, path });
  test('a fresh start (one blank New session tab) shows no strip', () => {
    expect(stripVisible([tab(home)], home, P)).toBe(false);
    expect(stripVisible([], home, P)).toBe(false);
  });
  test('any page open, or a second tab, shows it', () => {
    expect(stripVisible([tab(s1)], s1, P)).toBe(true);
    expect(stripVisible([tab(models)], models, P)).toBe(true);
    expect(stripVisible([tab(home)], `${home}/goals`, P)).toBe(true);
    expect(stripVisible([tab(home), tab(models)], models, P)).toBe(true);
  });
});

describe('desktop tabs: open and close', () => {
  test('a new tab opens right of the active one and takes focus', () => {
    let s = syncPath(empty, s1, g);
    s = openTab(s, s2);
    s = { ...s, activeId: s.tabs[0].id };
    s = openTab(s, home);
    expect(paths(s)).toEqual([s1, home, s2]);
    expect(activePath(s)).toBe(home);
  });

  test('a background tab (⌘-click) opens beside the active one without taking focus', () => {
    let s = syncPath(empty, s1, g);
    s = openTab(s, s2, null, true);
    expect(paths(s)).toEqual([s1, s2]);
    expect(activePath(s)).toBe(s1);
  });

  test('closing the active tab focuses the right neighbour, then the left', () => {
    let s = syncPath(empty, s1, g);
    s = openTab(s, s2);
    s = openTab(s, models);
    s = { ...s, activeId: s.tabs[1].id };
    const a = closeTab(s, s.tabs[1].id);
    expect(a.navigateTo).toBe(models);
    const b = closeTab(a.state, a.state.activeId!);
    expect(b.navigateTo).toBe(s1);
  });

  test('closing a background tab does not navigate', () => {
    let s = syncPath(empty, s1, g);
    s = openTab(s, s2);
    const r = closeTab(s, s.tabs[0].id);
    expect(r.navigateTo).toBeNull();
    expect(paths(r.state)).toEqual([s2]);
  });

  test('reopen brings the last closed tab back to its place and focuses it', () => {
    let s = syncPath(empty, s1, g);
    s = openTab(s, s2);
    s = openTab(s, models);
    s = closeTab(s, s.tabs[1].id).state;
    s = reopenClosed(s);
    expect(paths(s)).toEqual([s1, s2, models]);
    expect(activePath(s)).toBe(s2);
    expect(s.closed).toEqual([]);
    expect(s.tabs[1].index).toBeUndefined();
  });

  test('close others and close to the right keep pinned tabs', () => {
    let s = syncPath(empty, home, g);
    s = setPinned(s, s.tabs[0].id, true);
    s = openTab(s, s1);
    s = openTab(s, s2);
    s = openTab(s, models);
    const s1Id = s.tabs[1].id;
    expect(paths(closeToRight(s, s1Id))).toEqual([home, s1]);
    const others = closeOthers(s, s1Id);
    expect(paths(others)).toEqual([home, s1]);
    expect(activePath(others)).toBe(s1);
  });

  test('the cap drops the oldest unpinned inactive tab', () => {
    let s = syncPath(empty, home, g);
    s = setPinned(s, s.tabs[0].id, true);
    for (let i = 0; i < MAX_TABS + 3; i++) s = openTab(s, `${home}/sessions/x${i}`);
    expect(s.tabs.length).toBe(MAX_TABS);
    expect(s.tabs[0].path).toBe(home);
    expect(activePath(s)).toBe(`${home}/sessions/x${MAX_TABS + 2}`);
    expect(s.closed.map((t) => t.path)).toEqual([0, 1, 2, 3].map(s1Path));
  });

  test('reopening at the cap keeps the tab it pushes out reopenable', () => {
    let s = syncPath(empty, home, g);
    for (let i = 0; i < MAX_TABS; i++) s = openTab(s, s1Path(i));
    const before = new Set(s.tabs.map((t) => t.path));
    s = reopenClosed(s);
    expect(s.tabs.length).toBe(MAX_TABS);
    const lost = [...before].filter((p) => !s.tabs.some((t) => t.path === p));
    expect(lost.length).toBe(1);
    expect(s.closed.map((t) => t.path)).toEqual(lost);
  });

  test('reopen restores a closed tab even when another tab shows the same page', () => {
    let s = syncPath(empty, home, g);
    s = openTab(s, home);
    s = openTab(s, s1);
    s = closeTab(s, s.tabs[1].id).state;
    s = reopenClosed(s);
    expect(paths(s)).toEqual([home, home, s1]);
    expect(s.activeId).toBe(s.tabs[1].id);
  });
});

describe('desktop tabs: pin and reorder', () => {
  test('pinned tabs stay first through a reorder', () => {
    let s = syncPath(empty, s1, g);
    s = openTab(s, s2);
    s = setPinned(s, s.tabs[1].id, true);
    expect(paths(s)).toEqual([s2, s1]);
    s = reorder(s, [s.tabs[1].id, s.tabs[0].id]);
    expect(paths(s)).toEqual([s2, s1]);
  });

  test('a new tab never lands inside the pinned group', () => {
    let s = syncPath(empty, s1, g);
    s = openTab(s, s2);
    s = setPinned(s, s.tabs[0].id, true);
    s = setPinned(s, s.tabs[1].id, true);
    s = { ...s, activeId: s.tabs[0].id };
    s = openTab(s, home);
    expect(paths(s)).toEqual([s1, s2, home]);
  });
});

describe('tabRoute', () => {
  test('maps project paths to tab kinds', () => {
    expect(tabRoute(home, P)).toEqual({ kind: 'home' });
    expect(tabRoute(s1, P)).toEqual({ kind: 'session', sessionId: 's1' });
    expect(tabRoute(models, P)).toEqual({ kind: 'admin', section: 'models' });
    expect(tabRoute(`/workspaces/${P}/admin/agents/sales%20bot`, P)).toEqual({
      kind: 'agent',
      name: 'sales bot',
    });
    expect(tabRoute(`/workspaces/${P}/artifacts/a1?v=2`, P)).toEqual({
      kind: 'artifact',
      artifactId: 'a1',
    });
    expect(tabRoute(`/workspaces/${P}/customize/review`, P)).toEqual({
      kind: 'customize',
      section: 'review',
    });
  });

  test('rejects anything that is not an app path of this project', () => {
    expect(tabRoute(`https://evil.example/workspaces/${P}`, P)).toBeNull();
    expect(tabRoute(`//evil.example/workspaces/${P}`, P)).toBeNull();
    expect(tabRoute(`javascript:alert(1)//workspaces/${P}`, P)).toBeNull();
    // Resolves elsewhere than it reads: a backslash, an encoded dot segment.
    expect(tabRoute(`/workspaces/${P}/sessions\\..\\..\\other`, P)).toBeNull();
    expect(tabRoute(`/workspaces/${P}/%2e%2e/other/sessions/s1`, P)).toBeNull();
    expect(tabRoute(`/workspaces/${P}/sessions/../../other/sessions/s1`, P)).toBeNull();
    // A raw newline would split a stored path into two.
    expect(tabRoute(`/workspaces/${P}/sessions/x\n//evil.example/a`, P)).toBeNull();
    expect(tabRoute(`/workspaces/${P}/sessions/x\t`, P)).toBeNull();
  });

  test('keeps paths with spaces and Unicode', () => {
    expect(tabRoute(`/workspaces/${P}/admin/agents/sales bot`, P)).toEqual({
      kind: 'agent',
      name: 'sales bot',
    });
    expect(tabRoute(`/workspaces/${P}/spaces/équipe`, P)).toEqual({
      kind: 'space',
      slug: 'équipe',
    });
  });

  test('the Apps page with an App open is that App', () => {
    expect(tabRoute(`/workspaces/${P}/apps?app=x1`, P)).toEqual({ kind: 'app', appId: 'x1' });
    expect(tabRoute(`/workspaces/${P}/apps`, P)).toEqual({ kind: 'page', page: 'apps' });
  });

  test('ignores paths outside the project', () => {
    expect(tabRoute('/workspaces/other/sessions/s1', P)).toBeNull();
    expect(tabRoute('/settings', P)).toBeNull();
  });

  test('a project page the table does not name still gets its own tab', () => {
    expect(tabRoute(`/workspaces/${P}/unknown/x`, P)).toEqual({ kind: 'section', name: 'unknown' });
    expect(pathGroup(`/workspaces/${P}/unknown/x`, P)).toBe('section:unknown');
  });

  test('old addresses that redirect into settings belong to the section they land on', () => {
    const group = (rest: string) => pathGroup(`/workspaces/${P}/${rest}`, P);
    expect(group('evals')).toBe('customize:evals');
    expect(group('evals/jobs/j1')).toBe('customize:evals');
    expect(group('admin/eval-jobs/j1')).toBe('customize:evals');
    expect(group('reminders')).toBe('customize:reminders');
    expect(group('channels')).toBe('customize:connectors');
    expect(group('settings/x')).toBe('customize:general');
  });

  test('a page below a settings section belongs to that section', () => {
    const group = (rest: string) => pathGroup(`/workspaces/${P}/${rest}`, P);
    expect(group('admin/agents/kortix')).toBe(group('admin/agents'));
    expect(group('admin/connectors/slack/bot')).toBe(group('admin/connectors'));
    expect(group('admin/security')).not.toBe(group('admin/secrets'));
  });
});

describe('ownEntry', () => {
  const icons = { models: 'cpu' };
  test('a section from the URL never resolves to an Object.prototype member', () => {
    expect(ownEntry(icons, 'models')).toBe('cpu');
    expect(ownEntry(icons, 'constructor')).toBeUndefined();
    expect(ownEntry(icons, 'toString')).toBeUndefined();
    expect(ownEntry(icons, '__proto__')).toBeUndefined();
    expect(ownEntry(icons, null)).toBeUndefined();
    expect(isPrototypeKey('constructor')).toBe(true);
    expect(isPrototypeKey('apiKeys')).toBe(false);
  });
});

describe('sanitizePersisted', () => {
  test('keeps well-formed tabs and drops anything malformed, so a bad blob cannot crash the shell', () => {
    const out = sanitizePersisted({
      byProject: {
        p1: {
          tabs: [
            { id: 'a', path: '/workspaces/p1' },
            { id: 'b', path: 42 },
            null,
            { id: 'c', path: '/workspaces/p1/goals', pinned: 'yes' },
          ],
          activeId: 'zzz',
          closed: 'nope',
        },
        p2: 'garbage',
        __proto__: { tabs: [] },
      },
    });
    expect(Object.keys(out.byProject)).toEqual(['p1']);
    expect(out.byProject.p1).toEqual({
      tabs: [
        { id: 'a', path: '/workspaces/p1' },
        { id: 'c', path: '/workspaces/p1/goals' },
      ],
      activeId: null,
      closed: [],
      recent: [],
    });
  });

  test('drops stored tabs that are no page of the project; only the active tab stays a preview', () => {
    const ok = `/workspaces/${P}/sessions/s1`;
    const out = sanitizePersisted({
      byProject: {
        [P]: {
          tabs: [
            { id: 'a', path: 'javascript:alert(1)' },
            { id: 'b', path: '/workspaces/other/sessions/s1' },
            { id: 'c', path: ok, preview: true },
            { id: 'd', path: `${home}/sessions/s2`, preview: true },
          ],
          activeId: 'd',
          closed: [{ id: 'e', path: '//evil.example' }],
          recent: ['zz', 'c', 7, 'd'],
        },
      },
    });
    const p = out.byProject[P];
    expect(p.tabs.map((t) => t.id)).toEqual(['c', 'd']);
    expect(p.tabs.map((t) => !!t.preview)).toEqual([false, false]);
    expect(p.activeId).toBe('d');
    expect(p.recent).toEqual(['c', 'd']);
    expect(p.closed).toEqual([]);
  });

  test('anything that is not the stored shape becomes empty', () => {
    expect(sanitizePersisted(null)).toEqual({ byProject: {} });
    expect(sanitizePersisted({ byProject: [] })).toEqual({ byProject: {} });
  });
});
