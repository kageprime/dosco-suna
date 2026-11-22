import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act, useState } from 'react';
import type { Root } from 'react-dom/client';

// KRTX-4940: a pending CLI sign-in can create its workspace on
// `/cli/authorize` itself. Creating only selects the new workspace; the key is
// minted, the callback called and the device code approved only by a separate
// Authorize press, for the account the create answered with. A failed or
// cancelled create keeps the pending sign-in and the existing selection.

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

const win = new Window();
const setGlobal = (key: string, value: unknown) =>
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
setGlobal('window', win);
setGlobal('document', win.document);
setGlobal('navigator', win.navigator);
setGlobal('getComputedStyle', win.getComputedStyle.bind(win));
for (const key of Object.getOwnPropertyNames(win)) {
  if (/^[A-Z]/.test(key) && !(key in globalThis)) setGlobal(key, Reflect.get(win, key));
}
for (const key of ['Event', 'MouseEvent', 'PointerEvent', 'KeyboardEvent', 'FocusEvent']) {
  setGlobal(key, Reflect.get(win, key));
}

let params = new URLSearchParams();
const navigations: string[] = [];
mock.module('next/navigation', () => ({
  useRouter: () => ({
    replace: (url: string) => navigations.push(url),
    push: (url: string) => navigations.push(url),
    prefetch: () => {},
  }),
  useSearchParams: () => params,
  usePathname: () => '/cli/authorize',
  useParams: () => ({}),
}));
mock.module('@/features/providers/auth-provider', () => ({
  useAuth: () => ({ user: { email: 'member@example.test' }, isLoading: false }),
}));

type Row = { workspaceId: string; accountId: string; project: { name: string; icon: null; icon_glyph: null } };
const row = (id: string, name: string): Row => ({
  workspaceId: `w-${id}`,
  accountId: `a-${id}`,
  project: { name, icon: null, icon_glyph: null },
});
let openable: Row[] = [];
let listFailed = false;
mock.module('@kortix/ui/workspace/sidebar/use-workspace-directory', () => ({
  useWorkspaceDirectory: () => ({
    accounts: [],
    workspaces: openable,
    openable,
    loading: false,
    failedAccountIds: listFailed ? ['workspaces'] : [],
    reusableAccount: null,
    githubSourceAccount: null,
    retryFailed: () => {},
  }),
}));

// The network side of each Authorize: what was approved, minted and delivered.
const approved: Array<{ code: string; accountId?: string }> = [];
const minted: Array<{ name: string; accountId?: string }> = [];
const delivered: Array<{ url: string; body: unknown }> = [];
// Set to make the next mint answer the API's 409 `no_workspace`.
let mintRefusal: Error | null = null;
const NO_WORKSPACE = 'no_workspace';
mock.module('@kortix/sdk', () => ({
  approveCliDevice: async (code: string, options?: { accountId?: string }) => {
    approved.push({ code, accountId: options?.accountId });
    return {};
  },
  createAccountToken: async (input: { name: string; accountId?: string }) => {
    if (mintRefusal) {
      const refusal = mintRefusal;
      mintRefusal = null;
      throw refusal;
    }
    minted.push({ name: input.name, accountId: input.accountId });
    return { token_id: 'tok-1', secret_key: 'kortix_synthetic_secret' };
  },
  isNoWorkspaceError: (err: unknown) => err instanceof Error && err.message === NO_WORKSPACE,
  revokeAccountToken: async () => ({}),
}));
setGlobal('fetch', async (url: string, init: { body: string }) => {
  delivered.push({ url, body: JSON.parse(init.body) });
  return new Response('{}', { status: 200 });
});

// The create itself (`POST /projects/provision`) is the hook's own contract,
// tested beside it. Here it answers what the next test queues: a project, or
// a failure the hook formats.
type Outcome = { ok: true; accountId: string; workspaceId: string; name: string } | { ok: false; message: string };
let outcomes: Outcome[] = [];
const creates: string[] = [];
mock.module('@kortix/ui/workspace/new/use-create-workspace', () => ({
  useCreateWorkspace: (options: { enterProject: (id: string, project: unknown) => void }) => {
    const [status, setStatus] = useState<'idle' | 'creating' | 'error'>('idle');
    const [error, setError] = useState<string | null>(null);
    const [last, setLast] = useState<{ name: string } | null>(null);
    const create = async (state: { name: string }) => {
      creates.push(state.name);
      setLast(state);
      setStatus('creating');
      await Promise.resolve();
      const outcome = outcomes.shift() ?? { ok: false, message: 'no outcome queued' };
      if (outcome.ok) {
        options.enterProject(outcome.workspaceId, {
          project_id: outcome.workspaceId,
          account_id: outcome.accountId,
          name: outcome.name,
        });
        return;
      }
      setStatus('error');
      setError(outcome.message);
    };
    return {
      create,
      status,
      error: status === 'error' ? error : null,
      retry: () => {
        if (last) void create(last);
      },
      canRetry: status === 'error',
      limitReached: false,
      phase: null,
    };
  },
}));

const { createRoot } = await import('react-dom/client');
const { default: CliAuthorizePage } = await import('./page');

let root: Root | null = null;
function openLink(query: string) {
  params = new URLSearchParams(query);
  const host = document.createElement('div');
  document.body.appendChild(host);
  const mounted = createRoot(host);
  root = mounted;
  act(() => mounted.render(<CliAuthorizePage />));
}
beforeEach(() => {
  outcomes = [];
  listFailed = false;
  mintRefusal = null;
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  for (const list of [approved, minted, delivered, creates, navigations]) list.length = 0;
  document.body.innerHTML = '';
});

const CALLBACK = 'http://127.0.0.1:53682/callback';
const CALLBACK_QUERY = `callback=${encodeURIComponent(CALLBACK)}&state=state-nonce-1&label=build-box`;
const CREATED = { ok: true, accountId: 'a-new', workspaceId: 'w-new', name: 'Fresh Synthetic' } as const;

const buttons = () => [...document.querySelectorAll('button')];
function button(label: string): HTMLButtonElement {
  const found = buttons().find((el) => el.textContent?.trim() === label);
  if (!found) throw new Error(`no button "${label}" in: ${buttons().map((el) => el.textContent).join(' | ')}`);
  return found;
}
const hasButton = (label: string) => buttons().some((el) => el.textContent?.trim() === label);
const createForm = () => document.querySelector<HTMLFormElement>('[data-testid="cli-create-workspace"]');
const click = (el: Element) =>
  act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
const submitCreate = () =>
  act(async () => {
    createForm()!.requestSubmit();
  });

describe('creating a workspace during a callback sign-in', () => {
  test('with one workspace: create selects the new one, and only Authorize mints its key', async () => {
    openable = [row('one', 'Solo Synthetic')];
    openLink(CALLBACK_QUERY);

    await click(button('Create workspace'));
    expect(button('Authorize').disabled).toBe(true);
    outcomes = [CREATED];
    await submitCreate();

    expect(creates.length).toBe(1);
    expect(createForm()).toBeNull();
    // Create alone authorizes nothing.
    expect(minted).toEqual([]);
    expect(delivered).toEqual([]);
    expect(navigations).toEqual([]);

    await click(button('Authorize'));
    expect(minted).toEqual([{ name: 'CLI · build-box', accountId: 'a-new' }]);
    expect(delivered).toEqual([
      { url: CALLBACK, body: { state: 'state-nonce-1', token: 'kortix_synthetic_secret' } },
    ]);
  });

  test('with no workspace: the first one is created inline and consent follows without a restart', async () => {
    openable = [];
    openLink(CALLBACK_QUERY);
    expect(document.body.textContent).toContain('Create a workspace to sign in the CLI');
    expect(hasButton('Cancel')).toBe(false);

    outcomes = [CREATED];
    await submitCreate();

    expect(navigations).toEqual([]);
    expect(minted).toEqual([]);
    expect(document.body.textContent).toContain('build-box');
    await click(button('Authorize'));
    expect(minted).toEqual([{ name: 'CLI · build-box', accountId: 'a-new' }]);
    expect(delivered.map((entry) => entry.url)).toEqual([CALLBACK]);
  });

  test('a failed create keeps the pending sign-in; a retry then authorizes the exact callback and state', async () => {
    openable = [];
    openLink(CALLBACK_QUERY);

    outcomes = [{ ok: false, message: 'Could not create the workspace. Try again.' }, CREATED];
    await submitCreate();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Could not create the workspace');
    expect(createForm()).not.toBeNull();
    expect(params.toString()).toBe(CALLBACK_QUERY);

    await click(button('Try again'));
    expect(creates.length).toBe(2);
    await click(button('Authorize'));
    expect(delivered).toEqual([
      { url: CALLBACK, body: { state: 'state-nonce-1', token: 'kortix_synthetic_secret' } },
    ]);
  });

  test('a 409 no_workspace on Authorize offers the inline create, and the retry targets the created workspace', async () => {
    openable = [row('one', 'Solo Synthetic')];
    openLink(CALLBACK_QUERY);
    mintRefusal = new Error(NO_WORKSPACE);
    await click(button('Authorize'));
    expect(document.body.textContent).toContain('Create a workspace to sign in the CLI');

    outcomes = [CREATED];
    await submitCreate();
    await click(button('Authorize'));
    expect(minted).toEqual([{ name: 'CLI · build-box', accountId: 'a-new' }]);
    expect(delivered.map((entry) => entry.url)).toEqual([CALLBACK]);
  });

  test('a failed list refresh after the create keeps the consent for the created workspace', async () => {
    openable = [];
    openLink(CALLBACK_QUERY);
    outcomes = [CREATED];
    await submitCreate();

    listFailed = true;
    act(() => root?.render(<CliAuthorizePage />));
    expect(document.body.textContent).not.toContain("Couldn't load your workspaces");
    await click(button('Authorize'));
    expect(minted).toEqual([{ name: 'CLI · build-box', accountId: 'a-new' }]);
  });

  test('a double submit starts one create', async () => {
    openable = [];
    openLink(CALLBACK_QUERY);
    outcomes = [CREATED];
    await act(async () => {
      createForm()!.requestSubmit();
      createForm()!.requestSubmit();
    });
    expect(creates.length).toBe(1);
  });
});

describe('creating a workspace during a device sign-in', () => {
  const confirmCode = () => click(document.querySelector('button[role="checkbox"]')!);
  const approve = () =>
    act(async () => {
      document.querySelector<HTMLFormElement>('form:not([data-testid])')!.requestSubmit();
    });

  test('with several workspaces: the created one is approved, and only after the code is confirmed', async () => {
    openable = [row('one', 'First Synthetic'), row('two', 'Second Synthetic')];
    openLink('user_code=AB12CD34');

    await click(button('Create workspace'));
    outcomes = [CREATED];
    await submitCreate();
    expect(approved).toEqual([]);

    // The URL's code alone is not consent: the match confirmation still gates it.
    await approve();
    expect(approved).toEqual([]);
    await confirmCode();
    await approve();
    expect(approved).toEqual([{ code: 'AB12CD34', accountId: 'a-new' }]);
  });

  test('a cancelled or failed create keeps the existing selection', async () => {
    openable = [row('one', 'First Synthetic'), row('two', 'Second Synthetic')];
    openLink('user_code=AB12CD34');

    await click(button('Create workspace'));
    outcomes = [{ ok: false, message: 'Could not create the workspace. Try again.' }];
    await submitCreate();
    expect(createForm()).not.toBeNull();
    await click(button('Cancel'));
    expect(createForm()).toBeNull();

    await confirmCode();
    await approve();
    expect(approved).toEqual([{ code: 'AB12CD34', accountId: 'a-one' }]);
  });

  test('approve is refused while the create form is open', async () => {
    openable = [row('one', 'Solo Synthetic')];
    openLink('user_code=AB12CD34');
    await confirmCode();
    await click(button('Create workspace'));

    expect(button('Authorize CLI').disabled).toBe(true);
    await approve();
    expect(approved).toEqual([]);
  });
});
