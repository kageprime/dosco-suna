import { afterEach, expect, jest, spyOn, test } from 'bun:test';
import * as backend from './backend';
import { PREVIEW_WS_CONNECT_TIMEOUT_MS, previewWsHandlers, type PreviewWsData } from './ws-proxy';

const originalWebSocket = globalThis.WebSocket;
let invalidation: ReturnType<typeof spyOn> | undefined;
afterEach(() => {
  jest.useRealTimers();
  globalThis.WebSocket = originalWebSocket;
  invalidation?.mockRestore();
});

for (const event of ['error', 'close'] as const) {
  test(`a failed upstream handshake drops its cached ingress on ${event}`, () => {
    invalidation = spyOn(backend, 'invalidatePreviewLink').mockImplementation(() => {});
    let socket: any;
    globalThis.WebSocket = class {
      constructor() { socket = this; }
    } as any;
    const data: PreviewWsData = {
      type: 'preview-ws', url: 'wss://provider.test/kortix/pty/pty-1/connect', headers: {},
      ingress: { sandboxId: 'sandbox-1', port: 8000 },
    };
    previewWsHandlers.open({ data, close() {}, send() {} });
    if (event === 'error') socket.onerror();
    else socket.onclose({ code: 1006 });
    expect(invalidation).toHaveBeenCalledWith('sandbox-1', 8000);
  });
}

test('a clean established shell exit keeps the cached ingress', () => {
  invalidation = spyOn(backend, 'invalidatePreviewLink').mockImplementation(() => {});
  let socket: any;
  globalThis.WebSocket = class {
    constructor() { socket = this; }
  } as any;
  const data: PreviewWsData = {
    type: 'preview-ws', url: 'wss://provider.test/kortix/pty/pty-1/connect', headers: {},
    ingress: { sandboxId: 'sandbox-1', port: 8000 },
  };
  previewWsHandlers.open({ data, close() {}, send() {} });
  socket.onopen();
  socket.onclose({ code: 1000 });
  expect(invalidation).not.toHaveBeenCalled();
});

test('an upstream WS that never opens invalidates cached ingress and closes client with 4504', () => {
  jest.useFakeTimers();
  invalidation = spyOn(backend, 'invalidatePreviewLink').mockImplementation(() => {});
  let upstreamClosed = false;
  globalThis.WebSocket = class {
    close() { upstreamClosed = true; }
  } as any;
  const closed: Array<[number | undefined, string | undefined]> = [];
  const data: PreviewWsData = {
    type: 'preview-ws',
    url: 'wss://provider.test/stream',
    headers: {},
    ingress: { sandboxId: 'sandbox-timeout', port: 6902 },
  };
  previewWsHandlers.open({
    data,
    close(code?: number, reason?: string) { closed.push([code, reason]); },
    send() {},
  });
  jest.advanceTimersByTime(PREVIEW_WS_CONNECT_TIMEOUT_MS + 10);
  expect(invalidation).toHaveBeenCalledWith('sandbox-timeout', 6902);
  expect(upstreamClosed).toBe(true);
  expect(closed).toEqual([[4504, 'upstream connect timeout']]);
});
