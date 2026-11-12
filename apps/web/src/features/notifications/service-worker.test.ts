import { beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `public/sw.js` runs in a service worker, which bun does not have. The file
 * reads one global, `self`, so the test hands it a fake one: the event
 * listeners it registers, `registration.showNotification`, and `clients`.
 */

const ORIGIN = 'https://app.example.test';
const source = readFileSync(join(import.meta.dir, '../../../public/sw.js'), 'utf8');

type Handler = (event: Record<string, unknown>) => void;
type FakeClient = {
  url: string;
  focused: boolean;
  focus: () => Promise<FakeClient>;
  navigate: (url: string) => Promise<FakeClient | null>;
  postMessage: (message: unknown) => void;
};
type Shown = { title: string; options: Record<string, unknown> };

let handlers: Record<string, Handler>;
let shown: Shown[];
/** The notifications on screen by tag: a same-tag notification replaces the last. */
let onScreen: Map<string, { data: unknown }>;
let opened: string[];
let navigated: string[];
let focusedUrls: string[];
let posted: { url: string; message: unknown }[];
let windows: FakeClient[];
/** How often the worker gave up its waiting state (install + SKIP_WAITING). */
let skipWaitingCalls: number[];
/** How often the worker claimed its clients (activate). */
let claimed: number[];
/** The app-shell layer (KRTX-4719): the fake CacheStorage and the fetches it saw. */
let cachesApi: FakeCacheStorage;
let fetchCalls: string[];
let fetchImpl: (input: string) => Promise<Response | undefined>;
/**
 * A notification click grants one window-interaction token. `focus` and
 * `openWindow` each spend it, as in Chrome, and a second spend in the same
 * click rejects. `navigate` spends nothing.
 */
let token = false;
function spendToken() {
  if (!token) throw new DOMException('Not allowed to open a window.', 'InvalidAccessError');
  token = false;
}

function client(url: string, focused = false, navigate?: FakeClient['navigate']): FakeClient {
  const fake: FakeClient = {
    url,
    focused,
    focus: async () => {
      spendToken();
      focusedUrls.push(fake.url);
      return fake;
    },
    navigate:
      navigate ??
      (async (next) => {
        navigated.push(next);
        return fake;
      }),
    postMessage: (message) => posted.push({ url: fake.url, message }),
  };
  return fake;
}

/** A `Response` as a real same-origin fetch returns it: type `basic`. */
function basicResponse(body: string, status = 200): Response {
  const response = new Response(body, { status });
  Object.defineProperty(response, 'type', { value: 'basic' });
  return response;
}

/** One named store. `match` honors `ignoreSearch` like the real Cache API. */
class FakeCache {
  store = new Map<string, Response>();

  #key(request: string | Request): string {
    return typeof request === 'string' ? new URL(request, ORIGIN).href : request.url;
  }

  async match(request: string | Request, options?: { ignoreSearch?: boolean }): Promise<Response | undefined> {
    const key = this.#key(request);
    if (!options?.ignoreSearch) {
      const hit = this.store.get(key);
      return hit ? hit.clone() : undefined;
    }
    const path = new URL(key).pathname;
    for (const [stored, response] of this.store) {
      if (new URL(stored).pathname === path) return response.clone();
    }
    return undefined;
  }

  async put(request: string | Request, response: Response): Promise<void> {
    this.store.set(this.#key(request), response.clone());
  }

  /** The real `add` fetches and stores, and rejects on a non-200. */
  async add(request: string | Request): Promise<void> {
    const url = this.#key(request);
    const response = await fetchImpl(url);
    if (!response || response.status !== 200) throw new Error(`add failed: ${url}`);
    await this.put(request, response);
  }

  async keys(): Promise<Request[]> {
    return [...this.store.keys()].map((key) => new Request(key));
  }

  async delete(request: string | Request): Promise<boolean> {
    return this.store.delete(this.#key(request));
  }
}

class FakeCacheStorage {
  opened: string[] = [];
  stores = new Map<string, FakeCache>();

  async open(name: string): Promise<FakeCache> {
    this.opened.push(name);
    let store = this.stores.get(name);
    if (!store) this.stores.set(name, (store = new FakeCache()));
    return store;
  }

  async keys(): Promise<string[]> {
    return [...this.stores.keys()];
  }

  async delete(name: string): Promise<boolean> {
    return this.stores.delete(name);
  }
}

beforeEach(() => {
  handlers = {};
  shown = [];
  onScreen = new Map();
  opened = [];
  navigated = [];
  focusedUrls = [];
  posted = [];
  windows = [];
  token = false;
  skipWaitingCalls = [];
  claimed = [];
  cachesApi = new FakeCacheStorage();
  fetchCalls = [];
  fetchImpl = async (input) => basicResponse(`body of ${new URL(input).pathname}`);
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, handler: Handler) => {
      handlers[type] = handler;
    },
    skipWaiting: () => {
      skipWaitingCalls.push(1);
    },
    registration: {
      showNotification: async (title: string, options: Record<string, unknown>) => {
        shown.push({ title, options });
        if (typeof options.tag === 'string') onScreen.set(options.tag, { data: options.data });
      },
      getNotifications: async ({ tag }: { tag: string }) => {
        const notification = onScreen.get(tag);
        return notification ? [notification] : [];
      },
    },
    clients: {
      claim: async () => {
        claimed.push(1);
      },
      matchAll: async () => windows,
      openWindow: async (url: string) => {
        spendToken();
        opened.push(url);
        return null;
      },
    },
  };
  // The shell layer reads `caches` and `fetch` as bare globals; the parameters
  // shadow them the same way a real worker's own scope does. The fetch shim
  // records every URL and delegates to the per-test `fetchImpl`.
  const fetchShim = async (input: string | Request) => {
    const url = typeof input === 'string' ? new URL(input, ORIGIN).href : input.url;
    fetchCalls.push(url);
    return fetchImpl(url);
  };
  new Function('self', 'caches', 'fetch', source)(self, cachesApi, fetchShim);
});

async function push(data: unknown) {
  const waits: Promise<unknown>[] = [];
  handlers.push({
    data: {
      json: () => {
        if (data instanceof Error) throw data;
        return data;
      },
    },
    waitUntil: (promise: Promise<unknown>) => waits.push(promise),
  });
  await Promise.all(waits);
}

async function click(url: unknown) {
  const waits: Promise<unknown>[] = [];
  let closed = false;
  token = true;
  handlers.notificationclick({
    notification: { data: { url }, close: () => (closed = true) },
    waitUntil: (promise: Promise<unknown>) => waits.push(promise),
  });
  await Promise.all(waits);
  return closed;
}

/** The time `sw.js` stamped on the nth notification it showed. */
const shownAt = (index: number) => (shown[index].options.data as { at: unknown }).at;

const message = {
  title: 'Release notes',
  body: 'The agent has a question.',
  tag: 'question:ses-b',
  url: '/workspaces/p1/sessions/ses-b?notification=n1',
  notificationId: 'n1',
  kind: 'question',
  type: 'question',
  projectId: 'p1',
  sessionId: 'ses-b',
  triggerSlug: null,
};

describe('sw.js push', () => {
  test('shows the message with its tag and the absolute session url', async () => {
    const before = Date.now();
    await push(message);
    expect(shown).toEqual([
      {
        title: 'Release notes',
        options: {
          body: 'The agent has a question.',
          tag: 'question:ses-b',
          renotify: false,
          data: { url: `${ORIGIN}/workspaces/p1/sessions/ses-b?notification=n1`, at: shownAt(0) },
          icon: '/favicon.svg',
        },
      },
    ]);
    expect(shownAt(0)).toBeGreaterThanOrEqual(before);
  });

  // Safari removes the subscription after 3 pushes that show no notification.
  test('shows the message even when a focused tab shows that page', async () => {
    windows = [client(`${ORIGIN}/workspaces/p1/sessions/ses-b`, true)];
    await push(message);
    expect(shown).toHaveLength(1);
  });

  test('shows the message whichever tab is open or focused', async () => {
    windows = [client(`${ORIGIN}/workspaces/p1/sessions/ses-b`, false)];
    await push(message);
    windows = [client(`${ORIGIN}/workspaces/p1/sessions/ses-a`, true)];
    await push(message);
    expect(shown).toHaveLength(2);
  });

  test('a later event with the same tag alerts again: the replacement is not silent', async () => {
    const url = `${ORIGIN}/workspaces/p1/sessions/ses-b`;
    onScreen.set('question:ses-b', { data: { url, at: Date.now() - 60_000 } });
    await push(message);
    // A notification from an older worker carries no time: it is an earlier event too.
    onScreen.set('question:ses-b', { data: { url } });
    await push(message);
    expect(shown.map((entry) => entry.options.renotify)).toEqual([true, true]);
  });

  test("the same event's second copy (the open tab's, or the push's) replaces the first quietly", async () => {
    await push(message);
    await push(message);
    expect(shown.map((entry) => entry.options.renotify)).toEqual([false, false]);
  });

  test('a url on another origin opens the app root instead', async () => {
    await push({ ...message, url: 'https://elsewhere.example.test/phish' });
    expect(shown[0].options.data).toEqual({ url: `${ORIGIN}/`, at: shownAt(0) });
    expect(typeof shownAt(0)).toBe('number');
  });

  test('an unreadable message still shows a notification, with no tag and no renotify', async () => {
    await push(new SyntaxError('not json'));
    expect(shown[0].title).toBe('Dosco');
    expect(shown[0].options).toMatchObject({ body: '', tag: undefined, renotify: false, data: { url: `${ORIGIN}/` } });
  });

  test('registers the shell handlers next to the push handlers', () => {
    expect(Object.keys(handlers).sort()).toEqual([
      'activate',
      'fetch',
      'install',
      'message',
      'notificationclick',
      'push',
    ]);
  });
});

describe('sw.js notificationclick', () => {
  const target = `${ORIGIN}/workspaces/p1/sessions/ses-b?notification=n1`;

  test('closes the notification and opens a window when no tab is open', async () => {
    expect(await click(target)).toBe(true);
    expect(opened).toEqual([target]);
  });

  test('focuses a tab already on the page and tells it which notification it opened', async () => {
    windows = [client(`${ORIGIN}/workspaces/p1`), client(`${ORIGIN}/workspaces/p1/sessions/ses-b`)];
    await click(target);
    expect(focusedUrls).toEqual([`${ORIGIN}/workspaces/p1/sessions/ses-b`]);
    expect(posted).toEqual([
      { url: `${ORIGIN}/workspaces/p1/sessions/ses-b`, message: { type: 'kortix:notification-open', url: target } },
    ]);
    expect(navigated).toEqual([]);
    expect(opened).toEqual([]);
  });

  test('a payload with the pre-2026-11-06 /projects path finds the tab on its /workspaces page', async () => {
    windows = [client(`${ORIGIN}/workspaces/p1/sessions/ses-b`)];
    await click(`${ORIGIN}/projects/p1/sessions/ses-b?notification=n1`);
    expect(focusedUrls).toEqual([`${ORIGIN}/workspaces/p1/sessions/ses-b`]);
    expect(posted).toEqual([
      { url: `${ORIGIN}/workspaces/p1/sessions/ses-b`, message: { type: 'kortix:notification-open', url: target } },
    ]);
    expect(opened).toEqual([]);
  });

  test('navigates another tab of the app, then focuses it', async () => {
    windows = [client('https://elsewhere.example.test/x'), client(`${ORIGIN}/workspaces/p1`)];
    await click(target);
    expect(navigated).toEqual([target]);
    expect(focusedUrls).toEqual([`${ORIGIN}/workspaces/p1`]);
    expect(opened).toEqual([]);
    expect(posted).toEqual([]);
  });

  test('opens a window when the tab refuses to navigate: focus did not spend the click', async () => {
    windows = [
      client(`${ORIGIN}/workspaces/p1`, false, async () => {
        throw new TypeError('not controlled');
      }),
    ];
    await click(target);
    expect(opened).toEqual([target]);
    expect(focusedUrls).toEqual([]);
    expect(posted).toEqual([]);
  });

  test('never navigates to another origin', async () => {
    await click('https://elsewhere.example.test/phish');
    expect(opened).toEqual([`${ORIGIN}/`]);
  });
});

/** Runs the fetch handler for `request` and settles everything it started. */
async function fetchEvent(request: Request) {
  const waits: Promise<unknown>[] = [];
  let responded = false;
  let response: Response | undefined;
  let respondedPromise: Promise<void> | undefined;
  handlers.fetch({
    request,
    respondWith: (promise: Promise<Response>) => {
      responded = true;
      respondedPromise = promise.then((settled) => {
        response = settled;
      });
    },
    waitUntil: (promise: Promise<unknown>) => waits.push(promise),
  });
  await Promise.all([...waits, respondedPromise].filter(Boolean));
  return { response, responded };
}

describe('sw.js app shell (KRTX-4719)', () => {
  // The version comes from the worker itself, so a bump never desyncs the suite.
  const SHELL_VERSION = source.match(/const SHELL_VERSION = '([^']+)'/)?.[1] ?? 'v0';
  const SHELL = `kortix-shell-${SHELL_VERSION}`;
  const STATIC = `kortix-static-${SHELL_VERSION}`;

  const navigate = (path: string) => new Request(`${ORIGIN}${path}`, { mode: 'navigate' });
  const staticRequest = (path: string, destination = 'script') => {
    const request = new Request(`${ORIGIN}${path}`);
    Object.defineProperty(request, 'destination', { value: destination });
    return request;
  };

  test('install precaches the offline page and never skips waiting', async () => {
    const waits: Promise<unknown>[] = [];
    handlers.install({ waitUntil: (promise: Promise<unknown>) => waits.push(promise) });
    await Promise.all(waits);
    expect(cachesApi.opened).toEqual([SHELL]);
    expect(await cachesApi.stores.get(SHELL)!.match('/offline.html')).toBeDefined();
    // Page-decided updates: only the page's SKIP_WAITING message takes over.
    expect(skipWaitingCalls).toEqual([]);
  });

  test('activate deletes the caches of other shell versions and claims the clients', async () => {
    // A warm worker holds its own caches; an older version's cache and an
    // unrelated one are also present.
    await cachesApi.open(SHELL);
    await cachesApi.open(STATIC);
    await cachesApi.open('kortix-shell-v0');
    await cachesApi.open('unrelated-cache');
    const waits: Promise<unknown>[] = [];
    handlers.activate({ waitUntil: (promise: Promise<unknown>) => waits.push(promise) });
    await Promise.all(waits);
    expect([...cachesApi.stores.keys()].sort()).toEqual([SHELL, STATIC, 'unrelated-cache'].sort());
    expect(claimed).toHaveLength(1);
  });

  test('SKIP_WAITING from the page takes over; nothing else does', () => {
    handlers.message({ data: { type: 'SKIP_WAITING' } });
    expect(skipWaitingCalls).toHaveLength(1);
    handlers.message({ data: { type: 'kortix:other' } });
    handlers.message({});
    expect(skipWaitingCalls).toHaveLength(1);
  });

  test('PURGE_SHELL on a signed-out surface clears the route HTML and keeps offline.html', async () => {
    const installWaits: Promise<unknown>[] = [];
    handlers.install({ waitUntil: (promise: Promise<unknown>) => installWaits.push(promise) });
    await Promise.all(installWaits);
    await fetchEvent(navigate('/workspaces/p1/sessions/s1'));
    const waits: Promise<unknown>[] = [];
    handlers.message({ data: { type: 'PURGE_SHELL' }, waitUntil: (promise: Promise<unknown>) => waits.push(promise) });
    await Promise.all(waits);
    const paths = (await cachesApi.stores.get(SHELL)!.keys()).map((key) => new URL(key.url).pathname);
    expect(paths).toEqual(['/offline.html']);
  });

  test('a navigation goes to the network and caches its HTML', async () => {
    const { response, responded } = await fetchEvent(navigate('/workspaces/p1/sessions/s1'));
    expect(responded).toBe(true);
    expect(fetchCalls).toEqual([`${ORIGIN}/workspaces/p1/sessions/s1`]);
    expect(response?.status).toBe(200);
    expect(await (await cachesApi.stores.get(SHELL)!.match('/workspaces/p1/sessions/s1'))!.text()).toBe(
      'body of /workspaces/p1/sessions/s1',
    );
  });

  test('a dead network serves the cached route HTML: the shell boots offline', async () => {
    await fetchEvent(navigate('/workspaces/p1/sessions/s1'));
    fetchImpl = () => Promise.reject(new TypeError('Failed to fetch'));
    const { response } = await fetchEvent(navigate('/workspaces/p1/sessions/s1?notification=n1'));
    expect(response?.status).toBe(200);
    expect(await response!.text()).toBe('body of /workspaces/p1/sessions/s1');
  });

  test('an unseen route offline serves the branded offline page', async () => {
    // Install ran at registration and precached offline.html.
    fetchImpl = async (input) =>
      input === `${ORIGIN}/offline.html`
        ? basicResponse('OFFLINE PAGE')
        : Promise.reject(new TypeError('Failed to fetch'));
    const installWaits: Promise<unknown>[] = [];
    handlers.install({ waitUntil: (promise: Promise<unknown>) => installWaits.push(promise) });
    await Promise.all(installWaits);
    const { response } = await fetchEvent(navigate('/workspaces/unseen'));
    expect(await response!.text()).toBe('OFFLINE PAGE');
  });

  test('nothing cached and the network dead: the navigation fails like the network', async () => {
    fetchImpl = () => Promise.reject(new TypeError('Failed to fetch'));
    const { response } = await fetchEvent(navigate('/workspaces/unseen'));
    expect(response?.status).toBe(0);
  });

  test('a static asset is stale-while-revalidate: cache answers, network refreshes', async () => {
    const first = await fetchEvent(staticRequest('/_next/static/chunk.abc.js'));
    expect(await first.response!.text()).toBe('body of /_next/static/chunk.abc.js');
    expect((await cachesApi.stores.get(STATIC)!.keys()).length).toBe(1);

    fetchImpl = async () => basicResponse('chunk v2');
    const warm = await fetchEvent(staticRequest('/_next/static/chunk.abc.js'));
    expect(await warm.response!.text()).toBe('body of /_next/static/chunk.abc.js');
    // The background refresh has settled with fetchEvent: the cache holds v2.
    expect(await (await cachesApi.stores.get(STATIC)!.match('/_next/static/chunk.abc.js'))!.text()).toBe('chunk v2');
  });

  test('only GET passes through the shell: a POST is never touched', async () => {
    const { responded } = await fetchEvent(new Request(`${ORIGIN}/v1/x`, { method: 'POST' }));
    expect(responded).toBe(false);
    expect(fetchCalls).toEqual([]);
  });

  test('another origin passes through: the cross-origin API never caches', async () => {
    const { responded } = await fetchEvent(new Request('https://api.example.test/v1/health'));
    expect(responded).toBe(false);
    expect(fetchCalls).toEqual([]);
  });

  test('the worker script itself passes through', async () => {
    const { responded } = await fetchEvent(new Request(`${ORIGIN}/sw.js`));
    expect(responded).toBe(false);
    expect(fetchCalls).toEqual([]);
  });

  test('a non-200 or a cross-origin response never caches', async () => {
    fetchImpl = async () => basicResponse('nope', 404);
    const { response } = await fetchEvent(navigate('/workspaces/x'));
    expect(response?.status).toBe(404);
    expect((await cachesApi.stores.get(SHELL)!.keys()).length).toBe(0);

    const opaque = new Response('opaque body');
    Object.defineProperty(opaque, 'type', { value: 'opaque' });
    fetchImpl = async () => opaque;
    const second = await fetchEvent(navigate('/workspaces/y'));
    expect(second.response?.status).toBe(200);
    expect((await cachesApi.stores.get(SHELL)!.keys()).length).toBe(0);
  });

  test('the shell cache stays bounded: the oldest route dies at nine entries', async () => {
    for (let i = 0; i < 9; i++) await fetchEvent(navigate(`/workspaces/p1/s${i}`));
    const keys = await cachesApi.stores.get(SHELL)!.keys();
    expect(keys.length).toBe(8);
    expect(keys.map((key) => new URL(key.url).pathname)).not.toContain('/workspaces/p1/s0');
  });

  test('the offline page survives the bound whatever the traffic', async () => {
    const installWaits: Promise<unknown>[] = [];
    handlers.install({ waitUntil: (promise: Promise<unknown>) => installWaits.push(promise) });
    await Promise.all(installWaits);
    for (let i = 0; i < 12; i++) await fetchEvent(navigate(`/workspaces/p1/t${i}`));
    const paths = (await cachesApi.stores.get(SHELL)!.keys()).map((key) => new URL(key.url).pathname);
    expect(paths).toContain('/offline.html');
    expect(paths.length).toBe(8);
  });

  test('the static cache stays bounded: the oldest asset dies at sixty-one entries', async () => {
    for (let i = 0; i < 61; i++) await fetchEvent(staticRequest(`/_next/static/f${i}.js`));
    const keys = await cachesApi.stores.get(STATIC)!.keys();
    expect(keys.length).toBe(60);
    expect(keys.map((key) => new URL(key.url).pathname)).not.toContain('/_next/static/f0.js');
  });
});
