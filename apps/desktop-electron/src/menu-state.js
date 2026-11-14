const { isAppPath } = require('./nav-rules');

/**
 * The URL a "Copy Current URL" action puts on the clipboard, or null when the
 * window is not on an app page (about:blank, a Chrome error page, a page a
 * redirect committed outside the app): only those open the same session when
 * pasted.
 */
function copyableUrl(url) {
  try {
    const parsed = new URL(url);
    const http = parsed.protocol === 'https:' || parsed.protocol === 'http:';
    return http && isAppPath(parsed.pathname) ? parsed.toString() : null;
  } catch {
    return null;
  }
}

/**
 * The menu items of the web app's desktop tab strip
 * (apps/web/src/features/desktop-tabs). Off until the page reports the strip
 * mounted (`kortix:tabs-active`, behind the project's `desktop_tabs` flag):
 * without tabs, Mod+T, Mod+1…9 and Ctrl+Tab stay the page's own keys.
 */
const TAB_MENU_IDS = [
  'kx-file-new-tab',
  'kx-file-reopen-tab',
  'kx-go-next-tab',
  'kx-go-prev-tab',
  ...Array.from({ length: 9 }, (_, index) => `kx-go-tab-${index + 1}`),
];

/** Hidden even while enabled: nine rows would crowd the menu. */
const HIDDEN_TAB_MENU_IDS = new Set(TAB_MENU_IDS.filter((id) => id.startsWith('kx-go-tab-')));

/**
 * `tabsActive`: the page's tab strip is mounted. Then every project page is a
 * tab and Close Tab works on all of them; else only a session or Customize,
 * the web's own session tabs.
 */
function menuContextForUrl(url, tabsActive = false) {
  let pathname = '';
  try {
    pathname = new URL(url).pathname;
  } catch {
    return { inProject: false, hasActiveTab: false };
  }
  const projectId = /^\/(?:workspaces|projects)\/([^/]+)(?:\/|$)/.exec(pathname)?.[1];
  const inProject = Boolean(projectId && projectId !== 'start' && projectId !== 'new');
  const hasActiveTab =
    inProject &&
    (tabsActive ||
      /^\/(?:workspaces|projects)\/[^/]+\/(?:sessions\/[^/]+|customize)(?:\/|$)/.test(pathname));
  return { inProject, hasActiveTab };
}

module.exports = { menuContextForUrl, copyableUrl, TAB_MENU_IDS, HIDDEN_TAB_MENU_IDS };
