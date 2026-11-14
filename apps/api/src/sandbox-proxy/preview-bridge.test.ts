/**
 * The preview location bridge (D-05): a framed preview page reports its own
 * address to the Kortix panel that frames it, because the panel cannot read a
 * cross-origin frame's location.
 */
import { describe, expect, test } from 'bun:test';

const {
  PREVIEW_LOCATION_MESSAGE,
  injectPreviewBridge,
  previewBridgeScript,
  shouldInjectPreviewBridge,
  varyOnFetchDest,
} = await import('./preview-bridge');

const PARENT = 'http://localhost:3000';

function frameRequest(dest = 'iframe'): Headers {
  return new Headers({ 'sec-fetch-dest': dest, accept: 'text/html' });
}

function htmlResponse(extra: Record<string, string> = {}): Headers {
  return new Headers({ 'content-type': 'text/html; charset=utf-8', ...extra });
}

function gate(overrides: Partial<Parameters<typeof shouldInjectPreviewBridge>[0]> = {}) {
  return shouldInjectPreviewBridge({
    method: 'GET',
    status: 200,
    upstreamPort: 3000,
    requestHeaders: frameRequest(),
    responseHeaders: htmlResponse(),
    parentOrigins: [PARENT],
    ...overrides,
  });
}

describe('shouldInjectPreviewBridge', () => {
  test('a framed HTML document from a user port gets the bridge', () => {
    expect(gate()).toBe(true);
  });

  test('a top-level navigation, a subresource, or no Sec-Fetch-Dest is left untouched', () => {
    expect(gate({ requestHeaders: frameRequest('document') })).toBe(false);
    expect(gate({ requestHeaders: frameRequest('script') })).toBe(false);
    expect(gate({ requestHeaders: new Headers({ accept: 'text/html' }) })).toBe(false);
  });

  test('non-GET, no-body, partial, non-HTML and encoded bodies are left untouched', () => {
    expect(gate({ method: 'POST' })).toBe(false);
    for (const status of [101, 204, 206, 304]) expect(gate({ status })).toBe(false);
    expect(gate({ responseHeaders: new Headers({ 'content-type': 'application/json' }) })).toBe(false);
    expect(gate({ responseHeaders: htmlResponse({ 'content-encoding': 'gzip' }) })).toBe(false);
    // A download keeps its exact bytes; `inline` is still a page.
    expect(gate({ responseHeaders: htmlResponse({ 'content-disposition': 'attachment; filename="r.html"' }) })).toBe(false);
    expect(gate({ responseHeaders: htmlResponse({ 'content-disposition': 'inline' }) })).toBe(true);
    expect(gate({ responseHeaders: new Headers({ 'content-type': 'text/html; charset=shift_jis' }) })).toBe(false);
  });

  test("an app's own HTML error page gets the bridge, so a broken link still moves the address bar", () => {
    expect(gate({ status: 404 })).toBe(true);
    expect(gate({ status: 500 })).toBe(true);
  });

  test('a page whose CSP governs scripts is left untouched (no CSP violation, no rewrite)', () => {
    expect(gate({ responseHeaders: htmlResponse({ 'content-security-policy': "script-src 'self'" }) })).toBe(false);
    expect(gate({ responseHeaders: htmlResponse({ 'content-security-policy': "default-src 'self'" }) })).toBe(false);
    expect(
      gate({ responseHeaders: htmlResponse({ 'content-security-policy-report-only': "script-src 'self'" }) }),
    ).toBe(false);
    // A directive with an empty source list still governs scripts.
    expect(gate({ responseHeaders: htmlResponse({ 'content-security-policy': 'script-src' }) })).toBe(false);
    expect(gate({ responseHeaders: htmlResponse({ 'content-security-policy': "default-src; img-src 'self'" }) })).toBe(false);
    // A CSP that does not govern scripts does not block an inline script.
    expect(gate({ responseHeaders: htmlResponse({ 'content-security-policy': "img-src 'self'" }) })).toBe(true);
  });

  test('the session-data ports and a deployment with no known parent origin are left untouched', () => {
    expect(gate({ upstreamPort: 8000 })).toBe(false);
    expect(gate({ parentOrigins: [] })).toBe(false);
  });
});

/** Runs the bridge in a fake frame and returns what it posted to its parent. */
function runBridge(opts: { prefix?: string; framed?: boolean; href: string; navigation?: boolean }) {
  const posted: { message: unknown; targetOrigin: string }[] = [];
  const listeners: Record<string, () => void> = {};
  let tick: (() => void) | null = null;
  let removed = false;
  const location = new URL(opts.href);
  const parent = { postMessage: (message: unknown, targetOrigin: string) => posted.push({ message, targetOrigin }) };
  const win: Record<string, unknown> = {};
  win.parent = opts.framed === false ? win : parent;
  let entryChanged: (() => void) | null = null;
  const navigation = { currentEntry: { index: 0, key: 'k0' } as { index: number; key: string }, addEventListener: (_: string, fn: () => void) => (entryChanged = fn) };
  if (opts.navigation) win.navigation = navigation;
  const script = previewBridgeScript({ prefix: opts.prefix ?? '', origins: [PARENT, 'https://alias.example'] });
  const body = script.replace(/^<script>/, '').replace(/<\/script>$/, '');
  const element = { parentNode: { removeChild: () => (removed = true) } };
  const history = { length: 1 };
  new Function('window', 'document', 'location', 'history', 'addEventListener', 'setInterval', body)(
    win,
    { currentScript: element },
    location,
    history,
    (name: string, fn: () => void) => (listeners[name] = fn),
    (fn: () => void) => (tick = fn),
  );
  return {
    posted,
    removed: () => removed,
    /** `push` grows `history.length` like a link or `pushState`; a replace does not. */
    navigate(href: string, push = true) {
      if (push) history.length += 1;
      location.href = href;
      tick?.();
    },
    fire(name: string) {
      listeners[name]?.();
    },
    /** Moves the Navigation API's current entry, as push/replace/traverse do. */
    goToEntry(href: string, index: number) {
      location.href = href;
      navigation.currentEntry = { index, key: `k${index}` };
      entryChanged?.();
    },
  };
}

describe('previewBridgeScript', () => {
  test('reports the frame path to every allowed parent origin, and nothing else', () => {
    const frame = runBridge({ href: 'http://p8765-sbx.localhost:8008/?q=1#top' });
    expect(frame.posted).toEqual([
      { message: { type: PREVIEW_LOCATION_MESSAGE, path: '/?q=1#top', length: 1, index: -1, key: '' }, targetOrigin: PARENT },
      {
        message: { type: PREVIEW_LOCATION_MESSAGE, path: '/?q=1#top', length: 1, index: -1, key: '' },
        targetOrigin: 'https://alias.example',
      },
    ]);
  });

  test('reports an in-frame navigation once, and an unchanged address never', () => {
    const frame = runBridge({ href: 'http://p8765-sbx.localhost:8008/' });
    frame.posted.length = 0;
    frame.navigate('http://p8765-sbx.localhost:8008/page2.html');
    frame.navigate('http://p8765-sbx.localhost:8008/page2.html');
    frame.fire('popstate');
    expect(frame.posted.map((p) => (p.message as { path: string }).path)).toEqual([
      '/page2.html',
      '/page2.html',
    ]);
  });

  test('carries history.length, which a replaceState does not grow', () => {
    const frame = runBridge({ href: 'http://p8765-sbx.localhost:8008/login' });
    frame.posted.length = 0;
    frame.navigate('http://p8765-sbx.localhost:8008/dashboard', false);
    frame.navigate('http://p8765-sbx.localhost:8008/settings');
    expect(frame.posted.filter((p) => p.targetOrigin === PARENT).map((p) => p.message)).toEqual([
      { type: PREVIEW_LOCATION_MESSAGE, path: '/dashboard', length: 1, index: -1, key: '' },
      { type: PREVIEW_LOCATION_MESSAGE, path: '/settings', length: 2, index: -1, key: '' },
    ]);
  });

  test('carries the Navigation API entry index and reports when only it changes', () => {
    const frame = runBridge({ href: 'http://p8765-sbx.localhost:8008/', navigation: true });
    frame.posted.length = 0;
    frame.goToEntry('http://p8765-sbx.localhost:8008/b', 1);
    frame.goToEntry('http://p8765-sbx.localhost:8008/b', 2);
    expect(
      frame.posted.filter((p) => p.targetOrigin === PARENT).map((p) => (p.message as { index: number }).index),
    ).toEqual([1, 2]);
  });

  test('strips the path-preview prefix so the parent sees the app path', () => {
    const frame = runBridge({
      prefix: '/v1/p/sbx_1/8765',
      href: 'http://localhost:8008/v1/p/sbx_1/8765/docs/a.html',
    });
    expect((frame.posted[0]!.message as { path: string }).path).toBe('/docs/a.html');
  });

  test('does nothing on a top-level page', () => {
    const frame = runBridge({ framed: false, href: 'http://p8765-sbx.localhost:8008/' });
    expect(frame.posted).toEqual([]);
  });

  test('removes its own <script> element, framed or not, so hydration sees the served DOM', () => {
    expect(runBridge({ href: 'http://p8765-sbx.localhost:8008/' }).removed()).toBe(true);
    expect(runBridge({ framed: false, href: 'http://p8765-sbx.localhost:8008/' }).removed()).toBe(true);
  });

  test('cannot be broken out of by a hostile prefix', () => {
    const script = previewBridgeScript({ prefix: '</script><script>alert(1)//', origins: [PARENT] });
    expect(script.match(/<\/script>/gi)?.length).toBe(1);
  });
});

describe('injectPreviewBridge', () => {
  test('puts the bridge at the start of <body> and drops the stale Content-Length', async () => {
    const html = '<!doctype html><html><head><meta charset="utf-8"></head><body><p>a</p></body></html>';
    const headers = htmlResponse({ 'content-length': String(html.length) });
    const out = await injectPreviewBridge(new Response(html, { headers }), '<script>B</script>');
    expect(out.headers.get('content-length')).toBeNull();
    expect(out.headers.get('vary')).toContain('Sec-Fetch-Dest');
    expect(await out.text()).toBe(
      '<!doctype html><html><head><meta charset="utf-8"></head><body><script>B</script><p>a</p></body></html>',
    );
  });

  test('a document with no <body> tag gets the bridge at its end', async () => {
    const out = await injectPreviewBridge(new Response('<p>bare</p>', { headers: htmlResponse() }), '<script>B</script>');
    expect(await out.text()).toBe('<p>bare</p><script>B</script>');
  });

  test('a <meta> CSP that governs scripts leaves the page untouched', async () => {
    const html =
      '<html><head><meta http-equiv="Content-Security-Policy" content="script-src \'self\'"></head><body><p>a</p></body></html>';
    const out = await injectPreviewBridge(new Response(html, { headers: htmlResponse() }), '<script>B</script>');
    expect(await out.text()).toBe(html);
  });

  test('a <meta> CSP that does not govern scripts still gets the bridge', async () => {
    const html = '<html><head><meta http-equiv="Content-Security-Policy" content="img-src *"></head><body></body></html>';
    const out = await injectPreviewBridge(new Response(html, { headers: htmlResponse() }), '<script>B</script>');
    expect(await out.text()).toContain('<body><script>B</script>');
  });

  test('a UTF-16 document (byte-order mark) passes through byte for byte', async () => {
    const bytes = new Uint8Array([0xff, 0xfe, 0x3c, 0x00, 0x62, 0x00, 0x3e, 0x00]);
    const out = await injectPreviewBridge(new Response(bytes, { headers: htmlResponse() }), '<script>B</script>');
    expect(new Uint8Array(await out.arrayBuffer())).toEqual(bytes);
  });

  test('a byte-order mark split across chunks is still seen', async () => {
    const bytes = [0xff, 0xfe, 0x3c, 0x00, 0x62, 0x00, 0x3e, 0x00];
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(bytes.slice(0, 1)));
        controller.enqueue(new Uint8Array(bytes.slice(1)));
        controller.close();
      },
    });
    const out = await injectPreviewBridge(new Response(body, { headers: htmlResponse() }), '<script>B</script>');
    expect(Array.from(new Uint8Array(await out.arrayBuffer()))).toEqual(bytes);
  });

  test('an upstream that fails in its first bytes still answers with a failing stream', async () => {
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error('upstream reset'));
      },
    });
    const out = await injectPreviewBridge(new Response(body, { headers: htmlResponse() }), '<script>B</script>');
    expect(out.status).toBe(200);
    await expect(out.text()).rejects.toThrow();
  });

  test('streams: the first chunk is delivered before the upstream finishes', async () => {
    const enc = new TextEncoder();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(enc.encode('<html><body><p>first</p>'));
        await gate;
        controller.enqueue(enc.encode('<p>second</p></body></html>'));
        controller.close();
      },
    });
    const out = await injectPreviewBridge(new Response(body, { headers: htmlResponse() }), '<script>B</script>');
    const reader = out.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toContain('<script>B</script><p>first</p>');
    release();
    await reader.cancel();
  });
});

// A page cached from a top-level tab must never fill the frame (Sol S1).
describe('varyOnFetchDest — framed and top-level HTML are cached apart', () => {
  test('every HTML answer and every 304 varies on Sec-Fetch-Dest, once', () => {
    for (const [status, type] of [[200, 'text/html'], [404, 'text/html; charset=utf-8'], [304, '']] as const) {
      const headers = new Headers(type ? { 'content-type': type, vary: 'Accept-Encoding' } : { vary: 'Accept-Encoding' });
      varyOnFetchDest(status, headers);
      varyOnFetchDest(status, headers);
      expect(headers.get('vary')).toBe('Accept-Encoding, Sec-Fetch-Dest');
    }
  });

  test('non-HTML assets are left alone', () => {
    const headers = new Headers({ 'content-type': 'application/javascript' });
    varyOnFetchDest(200, headers);
    expect(headers.get('vary')).toBeNull();
  });

  test('the rewritten page drops the validators of the original bytes', async () => {
    const headers = htmlResponse({ etag: '"abc"', 'last-modified': 'Fri, 13 Nov 2026 10:00:00 GMT' });
    const out = await injectPreviewBridge(new Response('<body></body>', { headers }), '<script>B</script>');
    expect(out.headers.get('etag')).toBeNull();
    expect(out.headers.get('last-modified')).toBeNull();
    expect(out.headers.get('vary')).toBe('Sec-Fetch-Dest');
  });
});
