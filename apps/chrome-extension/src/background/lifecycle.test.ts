// Worker-restart and control-socket lifecycles, driven through fake chrome + WebSocket globals.
import { afterEach, beforeEach, expect, jest, test } from 'bun:test';

class FakeWs {
  static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
  static all: FakeWs[] = [];
  readyState = FakeWs.CONNECTING;
  sent: string[] = [];
  onopen?: () => void;
  onmessage?: (e: { data: string }) => void;
  onclose?: (e: { code: number }) => void;
  constructor(public url: string) { FakeWs.all.push(this); }
  send(s: string) { this.sent.push(s); }
  open() { this.readyState = FakeWs.OPEN; this.onopen?.(); }
  close(code = 1005) {
    if (this.readyState === FakeWs.CLOSED) return;
    this.readyState = FakeWs.CLOSED;
    this.onclose?.({ code });
  }
}

const local: Record<string, unknown> = {};
const session: Record<string, unknown> = {};
const area = (m: Record<string, unknown>) => ({
  get: async (k: string | null) => (k === null ? { ...m } : { [k]: m[k] }),
  set: async (p: Record<string, unknown>) => void Object.assign(m, p),
  remove: async (ks: string[]) => ks.forEach((k) => delete m[k]),
});
const noop = async () => {};
(globalThis as any).WebSocket = FakeWs;
(globalThis as any).navigator ??= {};
(globalThis as any).chrome = {
  storage: { local: area(local), session: area(session) },
  runtime: { getManifest: () => ({ version: '1.0.0' }) },
  tabs: { query: async () => [], sendMessage: noop, ungroup: noop, remove: noop },
  scripting: { executeScript: noop },
  action: { setBadgeText: noop, setBadgeBackgroundColor: noop, setTitle: noop },
};

const { Hub } = await import('./hub');
const { Control, AUTH_TIMEOUT_MS } = await import('./control');

beforeEach(() => {
  FakeWs.all = [];
  for (const k of Object.keys(session)) delete session[k];
  Object.assign(local, { apiUrl: 'http://localhost:8008', token: 'tok', expiresAt: Date.now() + 3_600_000 });
});
afterEach(() => jest.useRealTimers());

const frame = { type: 'attach' as const, attachmentId: 'a1', sessionId: 's1', sessionTitle: 'T', projectId: 'p1',
  projectName: 'P', bridgePath: '/v1/chrome/bridge?x=1', ticket: 't', consent: false };

test('a paused attachment stays paused after the worker restarts', async () => {
  const before = new Hub(() => {});
  await before.onAttach(frame);
  before.all.get('a1')!.setPaused(true);
  await Bun.sleep(0);

  const after = new Hub(() => {}); // a new service worker: memory is gone, session storage is not
  await after.restore();
  expect(after.all.get('a1')!.paused).toBe(true);
});

test('resume is persisted too', async () => {
  const before = new Hub(() => {});
  await before.onAttach(frame);
  const a = before.all.get('a1')!;
  a.setPaused(true);
  a.setPaused(false);
  await Bun.sleep(0);
  const after = new Hub(() => {});
  await after.restore();
  expect(after.all.get('a1')!.paused).toBe(false);
});

test('a control socket that opens but never authenticates is closed and re-dialed', async () => {
  jest.useFakeTimers();
  const states: boolean[] = [];
  const c = new Control({ attach() {}, detach() {}, chrome() {}, authed() {}, disconnected() {}, state: (s) => states.push(s) });
  await c.connect();
  expect(FakeWs.all.length).toBe(1);
  FakeWs.all[0]!.open();
  await Promise.resolve(); await Promise.resolve();
  expect(FakeWs.all[0]!.sent.some((s) => JSON.parse(s).type === 'auth')).toBe(true);

  jest.advanceTimersByTime(AUTH_TIMEOUT_MS + 1);
  expect(FakeWs.all[0]!.readyState).toBe(FakeWs.CLOSED);
  await Promise.resolve(); await Promise.resolve();
  jest.advanceTimersByTime(30_000);
  for (let i = 0; i < 10; i++) await Promise.resolve();
  expect(FakeWs.all.length).toBe(2); // the retry dialed a fresh socket
  expect(c.online).toBe(false);
});

test('a control socket that authenticates in time stays open', async () => {
  jest.useFakeTimers();
  const c = new Control({ attach() {}, detach() {}, chrome() {}, authed() {}, disconnected() {}, state() {} });
  await c.connect();
  const ws = FakeWs.all[0]!;
  ws.open();
  await Promise.resolve(); await Promise.resolve();
  ws.onmessage!({ data: JSON.stringify({ type: 'auth_ok', chrome: { id: 'c1' }, webUrl: 'http://localhost:3000' }) });
  jest.advanceTimersByTime(AUTH_TIMEOUT_MS * 3);
  expect(ws.readyState).toBe(FakeWs.OPEN);
  expect(c.online).toBe(true);
  c.stop();
});


test('only the commanded tab is highlighted, including outside the group, and disconnect clears it', async () => {
  const messages = new Map<number, boolean>();
  const tabs = [
    { id: 10, windowId: 1, groupId: 7, url: 'https://a.test', title: 'A', active: true, index: 0, pinned: false, highlighted: false, incognito: false, selected: false, discarded: false, autoDiscardable: true, frozen: false, lastAccessed: 0 },
    { id: 20, windowId: 1, groupId: -1, url: 'https://b.test', title: 'B', active: false, index: 1, pinned: false, highlighted: false, incognito: false, selected: false, discarded: false, autoDiscardable: true, frozen: false, lastAccessed: 0 },
  ];
  const oldTabs = chrome.tabs;
  const oldDebugger = chrome.debugger;
  Object.assign(chrome, {
    tabs: { ...oldTabs, query: async () => tabs, get: async (id: number) => tabs.find((t) => t.id === id),
      sendMessage: async (id: number, m: { kortix: string; on: boolean }) => { if (m.kortix === 'overlay') messages.set(id, m.on); } },
    debugger: { attach: noop, detach: noop, sendCommand: noop,
      getTargets: async () => tabs.map((t) => ({ id: `T${t.id}`, tabId: t.id, type: 'page', url: t.url, title: t.title })) },
  });
  try {
    const hub = new Hub(() => {});
    await hub.onAttach(frame);
    const a = hub.all.get('a1');
    if (!a) throw new Error('attachment missing');
    a.groupId = 7;
    a.touched.add(10);
    const out: { result?: { sessionId?: string } }[] = [];
    // The bridge invokes this exact Shim instance. Capture its real replies without a socket.
    const originalSend = FakeWs.prototype.send;
    FakeWs.prototype.send = function (raw) { originalSend.call(this, raw); const f = JSON.parse(raw); if (f.m) out.push(f.m); };
    FakeWs.all.at(-1)?.open();
    const call = async (method: string, params: Record<string, unknown>, sessionId?: string) => {
      await a.shim.handle('overlay-test', { id: out.length + 1, method, params, sessionId });
      await Promise.resolve();
      return out.at(-1)?.result?.sessionId;
    };
    try {
      const first = await call('Target.attachToTarget', { targetId: 'T10' });
      const second = await call('Target.attachToTarget', { targetId: 'T20' });
      await a.refreshOverlays();
      expect([...messages.values()].every((on) => !on)).toBe(true);
      await call('Runtime.evaluate', { expression: 'document.title' }, first);
      expect(messages.get(10)).toBe(true);
      expect(messages.get(20) ?? false).toBe(false);
      await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 0, y: 0 }, second);
      expect(messages.get(10)).toBe(false);
      expect(messages.get(20)).toBe(true);
      // A load event on the old grouped tab must not resurrect its overlay.
      hub.onTabUpdated(10, { status: 'complete' }, tabs[0]);
      expect(messages.get(10)).toBe(false);
      a.shim.closeAll();
      expect(messages.get(20)).toBe(false);
      await a.end('stopped');
      expect([...messages.values()].every((on) => !on)).toBe(true);
    } finally { FakeWs.prototype.send = originalSend; await a.end('stopped'); }
  } finally { Object.assign(chrome, { tabs: oldTabs, debugger: oldDebugger }); }
});
