/**
 * The Browser panel's history model (`AppPreview`).
 *
 * The frame is cross-origin, so the panel cannot read its address. The preview
 * proxy adds a bridge to framed pages (`apps/api/src/sandbox-proxy/preview-bridge.ts`)
 * that posts `{ type: PREVIEW_LOCATION_MESSAGE, path }` to the panel. These
 * functions turn those reports into the address bar and Back/Forward (D-05).
 *
 * The history also outlives the `AppPreview` that built it, per session, so a
 * switch to Terminal and back reopens the same page with the same Back/Forward
 * (D-06). The session-change effect in `session-panel-provider.tsx` forgets it.
 */
import { parseLocalhostUrl, toInternalUrl } from '@kortix/sdk';

/** Same string as `PREVIEW_LOCATION_MESSAGE` in the API's preview-bridge.ts. */
export const PREVIEW_LOCATION_MESSAGE = 'kortix:preview-location';

/** Internal (localhost) URLs, oldest first; `index` is the page on screen. */
export interface FrameHistory {
  entries: string[];
  index: number;
}

export function currentEntry(history: FrameHistory): string {
  return history.entries[history.index] ?? '';
}

/** A new page opened by the panel itself: drops the forward entries. */
export function pushEntry(history: FrameHistory, url: string): FrameHistory {
  return { entries: [...history.entries.slice(0, history.index + 1), url], index: history.index + 1 };
}

/**
 * The internal URL a bridge message reports, on the port of the page the frame
 * loaded, or null when the message is not a location report.
 */
export function reportedFrameUrl(data: unknown, frameUrl: string): string | null {
  if (!data || typeof data !== 'object') return null;
  const { type, path } = data as { type?: unknown; path?: unknown };
  if (type !== PREVIEW_LOCATION_MESSAGE || typeof path !== 'string' || !path.startsWith('/')) return null;
  const port = parseLocalhostUrl(frameUrl)?.port;
  return port ? toInternalUrl(port, path) : null;
}

/** A number field of a bridge message (`length`, `index`), when present. */
function reportedNumber(data: unknown, key: 'length' | 'index'): number | null {
  const value = data && typeof data === 'object' ? (data as Record<string, unknown>)[key] : undefined;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** What one bridge report says, beyond the URL. */
export interface FrameReport {
  url: string;
  /** The first report after the panel loaded the frame. */
  settling: boolean;
  /** The frame's `navigation.currentEntry.index`; null without the Navigation API. */
  index: number | null;
  /** The frame's `history.length`; null when the frame sent none. */
  length: number | null;
  /** The frame's `navigation.currentEntry.key`: one id per history slot. */
  key: string | null;
}

export function frameReportOf(data: unknown, url: string, settling: boolean): FrameReport {
  const index = reportedNumber(data, 'index');
  const key = data && typeof data === 'object' ? (data as { key?: unknown }).key : undefined;
  return {
    url,
    settling,
    index: index !== null && index >= 0 ? index : null,
    length: reportedNumber(data, 'length'),
    key: typeof key === 'string' && key ? key : null,
  };
}

/**
 * What the panel remembers between reports of one frame: which panel entry
 * the frame's own history position `frame` mapped to at the load (`panel`),
 * and the last `history.length` (the fallback signal).
 */
export interface FrameTracker {
  base: { panel: number; frame: number } | null;
  length: number | null;
  /** Panel entry index -> the frame's entry key seen there. */
  keys: Record<number, string>;
}

export const NEW_FRAME_TRACKER: FrameTracker = { base: null, length: null, keys: {} };

function replaceCurrent(history: FrameHistory, url: string): FrameHistory {
  if (url === currentEntry(history)) return history;
  const entries = history.entries.slice();
  entries[history.index] = url;
  return { entries, index: history.index };
}

/**
 * Apply one report, the way a browser moves through its own history.
 *
 * - The first report after a load replaces the entry the panel opened (a
 *   server redirect lands here) and maps the frame's position to it.
 * - With the Navigation API the frame says WHERE in its own history it is,
 *   and which slot (`key`): the same position is a `replaceState` (an auth
 *   redirect `/login` -> `/dashboard`); a position whose slot key the panel
 *   saw there is a traversal (`history.back()`, the tab's Back); anything else
 *   is a push, which drops the entries after it, as a browser does. A push to
 *   a URL equal to the old forward entry is still a push: the key differs.
 *   A frame without keys falls back to URL equality.
 * - Without it, `history.length` is the signal: growth is a push; no growth is
 *   a step to a neighbor entry with this URL, else a replace. A push that
 *   drops forward entries keeps the length, so this fallback can misread it.
 * - A report with neither (no Navigation API and no `length`) pushes.
 */
export function reduceFrameReport(
  history: FrameHistory,
  tracker: FrameTracker,
  report: FrameReport,
): { history: FrameHistory; tracker: FrameTracker } {
  const { url, settling, index, length } = report;
  const { key } = report;
  if (settling) {
    return {
      history: replaceCurrent(history, url),
      tracker: {
        base: index === null ? null : { panel: history.index, frame: index },
        length,
        keys: key ? { [history.index]: key } : {},
      },
    };
  }
  const next: FrameTracker = { base: tracker.base, length, keys: tracker.keys };
  if (index !== null && tracker.base) {
    const target = Math.max(0, Math.min(history.entries.length, tracker.base.panel + index - tracker.base.frame));
    const keys = (upTo: number): Record<number, string> => {
      const kept: Record<number, string> = {};
      for (const [at, k] of Object.entries(tracker.keys)) if (Number(at) < upTo) kept[Number(at)] = k;
      if (key) kept[target] = key;
      return kept;
    };
    if (target === history.index) {
      return { history: replaceCurrent(history, url), tracker: { ...next, keys: { ...tracker.keys, ...(key ? { [target]: key } : {}) } } };
    }
    const seen = tracker.keys[target];
    const traversal = key && seen ? seen === key : !key && history.entries[target] === url;
    if (traversal) {
      return { history: replaceCurrent({ entries: history.entries, index: target }, url), tracker: next };
    }
    return {
      history: { entries: [...history.entries.slice(0, target), url], index: target },
      tracker: { ...next, keys: keys(target) },
    };
  }
  if (url === currentEntry(history)) return { history, tracker: next };
  if (tracker.length !== null && length !== null && length <= tracker.length) {
    for (const neighbor of [history.index - 1, history.index + 1]) {
      if (history.entries[neighbor] === url) return { history: { entries: history.entries, index: neighbor }, tracker: next };
    }
    return { history: replaceCurrent(history, url), tracker: next };
  }
  return { history: pushEntry(history, url), tracker: next };
}

// Per-session memory. Module scope because the `AppPreview` that owns the
// history unmounts on every switch to Terminal; keyed by the provider's
// session id, so two sessions never share a page.
const remembered = new Map<string, FrameHistory>();

export function rememberFrameHistory(key: string, history: FrameHistory): void {
  remembered.set(key, history);
}

export function recallFrameHistory(key: string): FrameHistory | undefined {
  return remembered.get(key);
}

export function forgetFrameHistory(key: string): void {
  remembered.delete(key);
  appsAtOpen.delete(key);
}

// The session's app list (as one string) when its Browser last opened.
const appsAtOpen = new Map<string, string>();

/** Records the session's app list when its Browser opens, by any route (the
 *  header, a chat link, an app card, an Outputs row). */
export function noteBrowserApps(key: string, apps: readonly string[]): void {
  appsAtOpen.set(key, apps.join('\n'));
}

/**
 * The history an untargeted Browser open (the header, the palette) resumes,
 * or undefined to open the first app as before. It resumes only a real page,
 * never the empty landing, and only while no app appeared since the Browser
 * last opened (`noteBrowserApps`): a new app the agent started is what the
 * user wants to see. `apps` is the session's app URLs in panel order.
 */
export function resumableFrameHistory(key: string, apps: readonly string[]): FrameHistory | undefined {
  const resumed = remembered.get(key);
  if (!resumed || !currentEntry(resumed)) return undefined;
  const seen = appsAtOpen.get(key);
  if (seen !== undefined && seen !== apps.join('\n')) return undefined;
  return resumed;
}

/**
 * The history an `AppPreview` opened on `url` starts from: the session's
 * remembered history when its current page IS `url` (the panel is resuming),
 * else a fresh one-entry history.
 */
export function initialFrameHistory(key: string | undefined, url: string): FrameHistory {
  const resumed = key ? remembered.get(key) : undefined;
  return resumed && currentEntry(resumed) === url ? resumed : { entries: [url], index: 0 };
}

/**
 * The authenticated preview URL for the page on screen. `previewUrl` was
 * minted for `frameUrl`, the page the frame loaded; after a navigation inside
 * the frame, `currentUrl` differs. Swap the app path and query, keep the
 * proxy prefix and the access parameters the URL carries.
 */
export function retargetPreviewUrl(previewUrl: string, frameUrl: string, currentUrl: string): string {
  if (!previewUrl || !currentUrl || currentUrl === frameUrl) return previewUrl;
  try {
    const out = new URL(previewUrl);
    const from = new URL(frameUrl);
    const to = new URL(currentUrl);
    if (from.port !== to.port || !out.pathname.endsWith(from.pathname)) return previewUrl;
    out.pathname = out.pathname.slice(0, out.pathname.length - from.pathname.length) + to.pathname;
    for (const key of new Set(from.searchParams.keys())) out.searchParams.delete(key);
    for (const [key, value] of to.searchParams) out.searchParams.append(key, value);
    out.hash = to.hash;
    return out.toString();
  } catch {
    return previewUrl;
  }
}
