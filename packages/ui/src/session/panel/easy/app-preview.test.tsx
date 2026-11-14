import { afterAll, describe, expect, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Window } from 'happy-dom';

const originalGlobals = ['window', 'document'].map((key) => ({
  key,
  descriptor: Object.getOwnPropertyDescriptor(globalThis, key),
}));
const window = new Window({ url: 'http://localhost/' });
Object.defineProperty(globalThis, 'window', { value: window, configurable: true });
Object.defineProperty(globalThis, 'document', { value: window.document, configurable: true });
afterAll(() => {
  for (const { key, descriptor } of originalGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  window.happyDOM.abort();
});

// ── A host's resolvePreviewUrl ─────────────────────────────────────────────
// The session Browser (AppPreview) frames a sandbox port. A host whose origin
// is not the Kortix backend resolves that URL on its server (UiProvider
// resolvePreviewUrl). AppPreview must frame the host's answer and must never
// put the SDK token into the frame URL.

describe('AppPreview — host resolvePreviewUrl', () => {
  test('frames the URL the host resolves for http://localhost:8090/', async () => {
    const { act, create } = await import('react-test-renderer');
    const { UiProvider } = await import('../../../providers/ui-provider');
    const { AppPreview } = await import('./app-preview');
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const asked: unknown[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(null, { status: 404 })) as unknown as typeof fetch;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let root!: ReturnType<typeof create>;
    try {
      await act(async () => {
        root = create(
          <QueryClientProvider client={client}>
            <UiProvider
              resolvePreviewUrl={async (request) => {
                asked.push(request);
                return 'https://host.example/frame?scoped=1';
              }}
            >
              <AppPreview
                url="http://localhost:8090/"
                name="localhost:8090"
                projectId="p1"
                shareContext={{ projectId: 'p1', sessionId: 's1' }}
                onClose={() => {}}
              />
            </UiProvider>
          </QueryClientProvider>,
        );
      });
      expect(asked).toEqual([
        { projectId: 'p1', sessionId: 's1', port: 8090, path: '/', url: 'http://localhost:8090/' },
      ]);
      expect(root.root.findByType('iframe').props.src).toBe('https://host.example/frame?scoped=1');
    } finally {
      await act(async () => root?.unmount());
      client.clear();
      globalThis.fetch = realFetch;
    }
  });
});

// ── D-05 / D-06: the address bar follows the frame; history survives a remount ──
// The frame is cross-origin. The preview proxy's bridge posts
// `{ type: 'kortix:preview-location', path }` to the panel; the panel must show
// that address, walk it with Back/Forward, and keep it across a switch to
// Terminal (AppPreview unmounts and mounts again).

describe('AppPreview — frame location and history', () => {
  async function mount(url: string, historyKey?: string) {
    const { act, create } = await import('react-test-renderer');
    const { UiProvider } = await import('../../../providers/ui-provider');
    const { AppPreview } = await import('./app-preview');
    const { SandboxAddressBar } = await import('../../../browser/sandbox-browser-chrome');
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const frameWindow = { postMessage() {} };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let root!: ReturnType<typeof create>;
    await act(async () => {
      root = create(
        <QueryClientProvider client={client}>
          <UiProvider resolvePreviewUrl={async (request) => `https://frame.example${request.path}`}>
            <AppPreview
              url={url}
              name="localhost:8765"
              projectId="p1"
              shareContext={{ projectId: 'p1', sessionId: 's1' }}
              historyKey={historyKey}
              onClose={() => {}}
            />
          </UiProvider>
        </QueryClientProvider>,
        { createNodeMock: (el) => (el.type === 'iframe' ? { contentWindow: frameWindow } : null) },
      );
    });
    const bar = () => root.root.findByType(SandboxAddressBar).props;
    const frameSrc = () => root.root.findByType('iframe').props.src as string;
    const report = async (path: string, source: unknown = frameWindow) => {
      await act(async () => {
        window.dispatchEvent(
          new window.MessageEvent('message', {
            data: { type: 'kortix:preview-location', path },
            origin: 'https://frame.example',
            source: source as never,
          }) as never,
        );
      });
    };
    const press = async (fn: () => void) => act(async () => fn());
    const unmount = async () => {
      await act(async () => root.unmount());
      client.clear();
    };
    return { bar, frameSrc, report, press, unmount };
  }

  test('an in-frame link updates the address; Back and Forward walk the frame history', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(null, { status: 404 })) as unknown as typeof fetch;
    const view = await mount('http://localhost:8765/');
    try {
      await view.report('/'); // the first load settles on the page the panel opened
      expect(view.bar().canGoBack).toBe(false);

      await view.report('/page2.html'); // a click inside the frame
      expect(view.bar().displayValue).toBe('http://localhost:8765/page2.html');
      // The frame navigated itself: the panel must not reload it.
      expect(view.frameSrc()).toBe('https://frame.example/');
      expect(view.bar().canGoBack).toBe(true);

      await view.press(view.bar().onBack);
      expect(view.bar().displayValue).toBe('http://localhost:8765/');
      expect(view.frameSrc()).toBe('https://frame.example/');
      expect(view.bar().canGoForward).toBe(true);

      await view.press(view.bar().onForward);
      expect(view.bar().displayValue).toBe('http://localhost:8765/page2.html');
      expect(view.frameSrc()).toBe('https://frame.example/page2.html');
    } finally {
      await view.unmount();
      globalThis.fetch = realFetch;
    }
  });

  test('a message from any other window is ignored', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(null, { status: 404 })) as unknown as typeof fetch;
    const view = await mount('http://localhost:8765/');
    try {
      await view.report('/evil', { postMessage() {} });
      expect(view.bar().displayValue).toBe('http://localhost:8765/');
    } finally {
      await view.unmount();
      globalThis.fetch = realFetch;
    }
  });

  test('a remount with the same historyKey resumes the page and its history', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(null, { status: 404 })) as unknown as typeof fetch;
    const { forgetFrameHistory, recallFrameHistory } = await import('./frame-history');
    forgetFrameHistory('session-a');
    try {
      const first = await mount('http://localhost:8765/', 'session-a');
      await first.report('/');
      await first.report('/page2.html');
      await first.unmount(); // switch to Terminal

      const resumed = recallFrameHistory('session-a');
      expect(resumed?.entries[resumed.index]).toBe('http://localhost:8765/page2.html');

      const second = await mount('http://localhost:8765/page2.html', 'session-a');
      expect(second.bar().displayValue).toBe('http://localhost:8765/page2.html');
      expect(second.frameSrc()).toBe('https://frame.example/page2.html');
      expect(second.bar().canGoBack).toBe(true);
      await second.unmount();

      // Another session starts fresh.
      const other = await mount('http://localhost:8765/page2.html', 'session-b');
      expect(other.bar().canGoBack).toBe(false);
      await other.unmount();
    } finally {
      forgetFrameHistory('session-a');
      forgetFrameHistory('session-b');
      globalThis.fetch = realFetch;
    }
  });
});
