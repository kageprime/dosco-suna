import { describe, expect, test } from 'bun:test';
import {
  type FrameHistory,
  frameReportOf,
  type FrameTracker,
  forgetFrameHistory,
  initialFrameHistory,
  NEW_FRAME_TRACKER,
  PREVIEW_LOCATION_MESSAGE,
  pushEntry,
  reduceFrameReport,
  rememberFrameHistory,
  reportedFrameUrl,
  noteBrowserApps,
  resumableFrameHistory,
  retargetPreviewUrl,
} from './frame-history';

const A = 'http://localhost:8765/';
const B = 'http://localhost:8765/page2.html';

describe('reportedFrameUrl', () => {
  test('maps a bridge report onto the loaded page port', () => {
    expect(reportedFrameUrl({ type: PREVIEW_LOCATION_MESSAGE, path: '/page2.html?x=1#h' }, A)).toBe(
      'http://localhost:8765/page2.html?x=1#h',
    );
  });

  test('rejects anything that is not a location report', () => {
    expect(reportedFrameUrl({ type: 'other', path: '/' }, A)).toBeNull();
    expect(reportedFrameUrl({ type: PREVIEW_LOCATION_MESSAGE, path: 'https://evil.example/' }, A)).toBeNull();
    expect(reportedFrameUrl({ type: PREVIEW_LOCATION_MESSAGE, path: 42 }, A)).toBeNull();
    expect(reportedFrameUrl('kortix:preview-location', A)).toBeNull();
    expect(reportedFrameUrl({ type: PREVIEW_LOCATION_MESSAGE, path: '/' }, '')).toBeNull();
  });
});

describe('pushEntry', () => {
  test('drops forward entries', () => {
    expect(pushEntry({ entries: [A, B], index: 0 }, '')).toEqual({ entries: [A, ''], index: 1 });
  });
});

describe('initialFrameHistory', () => {
  test('resumes the remembered history only when it is on the same page', () => {
    rememberFrameHistory('s', { entries: ['', A, B], index: 2 });
    try {
      expect(initialFrameHistory('s', B)).toEqual({ entries: ['', A, B], index: 2 });
      expect(initialFrameHistory('s', A)).toEqual({ entries: [A], index: 0 });
      expect(initialFrameHistory(undefined, B)).toEqual({ entries: [B], index: 0 });
      forgetFrameHistory('s');
      expect(initialFrameHistory('s', B)).toEqual({ entries: [B], index: 0 });
    } finally {
      forgetFrameHistory('s');
    }
  });
});

/**
 * Drives `reduceFrameReport` with raw bridge payloads, the way `AppPreview`
 * does: `frame(path, { index, length })` is one report; the first after a
 * `load()` settles.
 */
function panel(start: FrameHistory) {
  let history = start;
  let tracker: FrameTracker = NEW_FRAME_TRACKER;
  let settling = true;
  return {
    load() {
      settling = true;
    },
    frame(path: string, data: { index?: number; length?: number; key?: string } = {}) {
      const url = reportedFrameUrl({ type: PREVIEW_LOCATION_MESSAGE, path }, A)!;
      const report = frameReportOf({ type: PREVIEW_LOCATION_MESSAGE, path, ...data }, url, settling);
      settling = false;
      ({ history, tracker } = reduceFrameReport(history, tracker, report));
      return history;
    },
  };
}

const C = 'http://localhost:8765/c';
const LOGIN = 'http://localhost:8765/login';
const DASH = 'http://localhost:8765/dashboard';

describe('reduceFrameReport with the Navigation API index', () => {
  test('the first report replaces the opened entry (a server redirect)', () => {
    const p = panel({ entries: ['', A], index: 1 });
    expect(p.frame('/page2.html', { index: 0, length: 2 })).toEqual({ entries: ['', B], index: 1 });
  });

  test('a link pushes; replaceState (/login -> /dashboard) replaces', () => {
    const p = panel({ entries: [A], index: 0 });
    p.frame('/', { index: 0, length: 1 });
    expect(p.frame('/login', { index: 1, length: 2 })).toEqual({ entries: [A, LOGIN], index: 1 });
    expect(p.frame('/dashboard', { index: 1, length: 2 })).toEqual({ entries: [A, DASH], index: 1 });
  });

  test('the app walks back, then pushes: the forward entry is dropped (Sol S3)', () => {
    const p = panel({ entries: [A], index: 0 });
    p.frame('/', { index: 0, length: 1 });
    p.frame('/page2.html', { index: 1, length: 2 });
    expect(p.frame('/c', { index: 2, length: 3 })).toEqual({ entries: [A, B, C], index: 2 });
    expect(p.frame('/page2.html', { index: 1, length: 3 })).toEqual({ entries: [A, B, C], index: 1 });
    expect(p.frame('/dashboard', { index: 2, length: 3 })).toEqual({ entries: [A, B, DASH], index: 2 });
  });

  test('history.back() then forward() walks without changing the entries', () => {
    const p = panel({ entries: [A], index: 0 });
    p.frame('/', { index: 0, length: 1 });
    p.frame('/page2.html', { index: 1, length: 2 });
    expect(p.frame('/', { index: 0, length: 2 })).toEqual({ entries: [A, B], index: 0 });
    expect(p.frame('/page2.html', { index: 1, length: 2 })).toEqual({ entries: [A, B], index: 1 });
  });

  test('a panel Back reload maps the new frame onto the panel entry it opened', () => {
    const p = panel({ entries: [A], index: 0 });
    p.frame('/', { index: 0, length: 1 });
    p.frame('/page2.html', { index: 1, length: 2 });
    // Panel Back: index moves to 0 and a fresh frame loads A (its own index 0).
    const back = panel({ entries: [A, B], index: 0 });
    back.frame('/', { index: 0, length: 3 });
    expect(back.frame('/c', { index: 1, length: 4 })).toEqual({ entries: [A, C], index: 1 });
  });
});

describe('reduceFrameReport with Navigation API entry keys', () => {
  const D = 'http://localhost:8765/d';

  test('a push to a URL equal to the old forward entry is a push, not a traversal (Sol S3)', () => {
    const p = panel({ entries: [A], index: 0 });
    p.frame('/', { index: 0, length: 1, key: 'ka' });
    p.frame('/page2.html', { index: 1, length: 2, key: 'kb' });
    p.frame('/c', { index: 2, length: 3, key: 'kc' });
    expect(p.frame('/d', { index: 3, length: 4, key: 'kd' })).toEqual({ entries: [A, B, C, D], index: 3 });
    expect(p.frame('/page2.html', { index: 1, length: 4, key: 'kb' })).toEqual({ entries: [A, B, C, D], index: 1 });
    // pushState('/c') from B: a NEW slot (new key) at index 2, so D is dropped.
    expect(p.frame('/c', { index: 2, length: 3, key: 'kc2' })).toEqual({ entries: [A, B, C], index: 2 });
  });

  test('back and forward by key keep the forward entries', () => {
    const p = panel({ entries: [A], index: 0 });
    p.frame('/', { index: 0, length: 1, key: 'ka' });
    p.frame('/page2.html', { index: 1, length: 2, key: 'kb' });
    p.frame('/c', { index: 2, length: 3, key: 'kc' });
    expect(p.frame('/', { index: 0, length: 3, key: 'ka' })).toEqual({ entries: [A, B, C], index: 0 });
    expect(p.frame('/c', { index: 2, length: 3, key: 'kc' })).toEqual({ entries: [A, B, C], index: 2 });
  });

  test('replaceState keeps the slot: same index and key replaces the URL', () => {
    const p = panel({ entries: [A], index: 0 });
    p.frame('/', { index: 0, length: 1, key: 'ka' });
    p.frame('/login', { index: 1, length: 2, key: 'kl' });
    expect(p.frame('/dashboard', { index: 1, length: 2, key: 'kl' })).toEqual({ entries: [A, DASH], index: 1 });
  });
});

describe('reduceFrameReport without the Navigation API (history.length fallback)', () => {
  test('growth pushes; no growth replaces (replaceState)', () => {
    const p = panel({ entries: [A], index: 0 });
    p.frame('/', { length: 2 });
    expect(p.frame('/login', { length: 3 })).toEqual({ entries: [A, LOGIN], index: 1 });
    expect(p.frame('/dashboard', { length: 3 })).toEqual({ entries: [A, DASH], index: 1 });
  });

  test('no growth to a neighbor entry is a traversal', () => {
    const p = panel({ entries: [A], index: 0 });
    p.frame('/', { length: 1 });
    p.frame('/page2.html', { length: 2 });
    expect(p.frame('/', { length: 2 })).toEqual({ entries: [A, B], index: 0 });
  });

  test('a report with no index and no length pushes', () => {
    const p = panel({ entries: [A], index: 0 });
    p.frame('/');
    expect(p.frame('/page2.html')).toEqual({ entries: [A, B], index: 1 });
    expect(p.frame('/')).toEqual({ entries: [A, B, A], index: 2 });
  });
});

// Council C1: the header's Browser resumes only a real page, and never hides a
// new app the agent started.
describe('resumableFrameHistory', () => {
  test('never resumes the empty landing', () => {
    rememberFrameHistory('r1', { entries: [''], index: 0 });
    try {
      expect(resumableFrameHistory('r1', [])).toBeUndefined();
      expect(resumableFrameHistory('r1', ['http://localhost:3000/'])).toBeUndefined();
    } finally {
      forgetFrameHistory('r1');
    }
  });

  test('resumes the page while the app list is unchanged; a new app wins', () => {
    const apps = ['http://localhost:3000/'];
    noteBrowserApps('r2', apps);
    rememberFrameHistory('r2', { entries: [A, B], index: 1 });
    try {
      expect(resumableFrameHistory('r2', apps)).toEqual({ entries: [A, B], index: 1 });
      expect(resumableFrameHistory('r2', ['http://localhost:4000/', ...apps])).toBeUndefined();
    } finally {
      forgetFrameHistory('r2');
    }
  });

  test('a TARGETED open (chat link, app card) also records the app list it saw', () => {
    // The Browser opened on a chat link with one app; the agent then starts another.
    noteBrowserApps('r3', ['http://localhost:8765/']);
    rememberFrameHistory('r3', { entries: [A, B], index: 1 });
    try {
      expect(resumableFrameHistory('r3', ['http://localhost:3000/', 'http://localhost:8765/'])).toBeUndefined();
    } finally {
      forgetFrameHistory('r3');
    }
  });
});

// Council (Sol) C4: Open in new tab opens the page on screen.
describe('retargetPreviewUrl', () => {
  test('swaps the app path and query on a preview origin, keeping the access ticket', () => {
    expect(
      retargetPreviewUrl('https://p8765-sbx.preview.example/?__kortix_ticket=t1', A, 'http://localhost:8765/page2.html?x=1#h'),
    ).toBe('https://p8765-sbx.preview.example/page2.html?__kortix_ticket=t1&x=1#h');
  });

  test('keeps the path-mode proxy prefix', () => {
    expect(retargetPreviewUrl('http://localhost:8008/v1/p/sbx/8765/', A, B)).toBe(
      'http://localhost:8008/v1/p/sbx/8765/page2.html',
    );
  });

  test('returns the URL unchanged when nothing moved or the ports differ', () => {
    expect(retargetPreviewUrl('http://localhost:8008/v1/p/sbx/8765/', A, A)).toBe('http://localhost:8008/v1/p/sbx/8765/');
    expect(retargetPreviewUrl('http://localhost:8008/v1/p/sbx/8765/', A, 'http://localhost:3000/x')).toBe(
      'http://localhost:8008/v1/p/sbx/8765/',
    );
  });
});
