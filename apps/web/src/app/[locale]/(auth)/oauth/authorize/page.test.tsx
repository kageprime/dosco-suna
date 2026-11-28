import { expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

/**
 * Characterization for `/oauth/authorize` (KRTX-5209): which screen the
 * consent page lands on for a remembered and a fresh consent, and what it
 * submits. Pinned before the unreachable `consentRequest.remembered` render
 * branch is deleted; the expectations read the same before and after.
 */

type ConsentRequest = {
  client_name: string;
  scopes: string[];
  remembered: boolean;
  asks_workspace?: boolean;
  redirect_to?: string;
};
type SubmitInput = { requestId: string; approved: boolean; workspaceId?: string };

let consentRequest: ConsentRequest;
let workspaces: { workspace_id: string; name: string }[] = [];
let submitResult: () => Promise<{ redirect_uri?: string }>;
const submits: SubmitInput[] = [];

mock.module('@kortix/sdk', () => ({
  getOAuthConsentRequest: async () => consentRequest,
  listWorkspaces: async () => workspaces,
  submitOAuthConsent: async (input: SubmitInput) => {
    submits.push(input);
    return submitResult();
  },
}));
mock.module('@/lib/supabase/client', () => ({
  createClient: () => ({
    auth: { getSession: async () => ({ data: { session: { access_token: 'test-token' } } }) },
  }),
}));
mock.module('@/lib/env-config', () => ({ getEnv: () => ({ BACKEND_URL: 'http://localhost:8008/v1' }) }));
mock.module('@/features/providers/auth-provider', () => ({
  useAuth: () => ({ user: { id: 'user-1', email: 'person@example.test' }, isLoading: false }),
}));
const searchParams = new URLSearchParams('request_id=req-1');
mock.module('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {}, prefetch: () => {} }),
  useSearchParams: () => searchParams,
  useParams: () => ({}),
  usePathname: () => '/oauth/authorize',
}));

const { default: OAuthConsentPage } = await import('./page');

// The redirect target the page assigns; `window` exists only for these tests.
const location = { href: 'http://localhost:3000/oauth/authorize?request_id=req-1' };

async function render(): Promise<ReactTestRenderer> {
  submits.length = 0;
  location.href = 'http://localhost:3000/oauth/authorize?request_id=req-1';
  Object.defineProperty(globalThis, 'window', { value: { location }, configurable: true, writable: true });
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(createElement(OAuthConsentPage));
  });
  // One flush for the load effect's session, request, workspace and submit reads.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  return renderer;
}

async function unmount(renderer: ReactTestRenderer) {
  await act(async () => {
    renderer.unmount();
  });
  Reflect.deleteProperty(globalThis, 'window');
}

/** Every text leaf of the rendered tree, joined. */
function textOf(renderer: ReactTestRenderer): string {
  let out = '';
  const walk = (node: ReactTestInstance | string | number) => {
    if (typeof node === 'string' || typeof node === 'number') {
      out += `${node}`;
      return;
    }
    for (const child of node.children) walk(child as ReactTestInstance);
  };
  walk(renderer.root);
  return out;
}

test('a fresh consent shows the Allow screen and submits nothing', async () => {
  consentRequest = { client_name: 'Test App', scopes: ['profile'], remembered: false };
  workspaces = [];
  submitResult = async () => ({ redirect_uri: 'https://client.example.test/cb' });
  const renderer = await render();
  expect(textOf(renderer)).toContain('Authorize Test App');
  expect(textOf(renderer)).toContain('Allow');
  expect(submits).toEqual([]);
  await unmount(renderer);
});

test('a remembered consent approves on its own and redirects without the Allow screen', async () => {
  consentRequest = { client_name: 'Test App', scopes: ['profile'], remembered: true };
  workspaces = [];
  submitResult = async () => ({ redirect_uri: 'https://client.example.test/cb?code=1' });
  const renderer = await render();
  expect(submits).toEqual([{ requestId: 'req-1', approved: true }]);
  expect(location.href).toBe('https://client.example.test/cb?code=1');
  expect(textOf(renderer)).not.toContain('Authorize Test App');
  await unmount(renderer);
});

test('a remembered consent with one workspace approves for that workspace', async () => {
  consentRequest = { client_name: 'Test App', scopes: ['profile'], remembered: true, asks_workspace: true };
  workspaces = [{ workspace_id: 'ws-1', name: 'Workspace One' }];
  submitResult = async () => ({ redirect_uri: 'https://client.example.test/cb?code=2' });
  const renderer = await render();
  expect(submits).toEqual([{ requestId: 'req-1', approved: true, workspaceId: 'ws-1' }]);
  expect(location.href).toBe('https://client.example.test/cb?code=2');
  expect(textOf(renderer)).not.toContain('Authorize Test App');
  await unmount(renderer);
});

test('a remembered consent with a workspace choice shows the Allow screen and submits nothing', async () => {
  consentRequest = { client_name: 'Test App', scopes: ['profile'], remembered: true, asks_workspace: true };
  workspaces = [
    { workspace_id: 'ws-1', name: 'Workspace One' },
    { workspace_id: 'ws-2', name: 'Workspace Two' },
  ];
  submitResult = async () => ({ redirect_uri: 'https://client.example.test/cb' });
  const renderer = await render();
  expect(submits).toEqual([]);
  expect(textOf(renderer)).toContain('Authorize Test App');
  await unmount(renderer);
});

test('a failed remembered approval falls back to the Allow screen with the error', async () => {
  consentRequest = { client_name: 'Test App', scopes: ['profile'], remembered: true };
  workspaces = [];
  submitResult = async () => {
    throw new Error('This authorization request expired.');
  };
  const renderer = await render();
  expect(submits).toEqual([{ requestId: 'req-1', approved: true }]);
  expect(textOf(renderer)).toContain('Authorize Test App');
  expect(textOf(renderer)).toContain('This authorization request expired.');
  expect(location.href).toBe('http://localhost:3000/oauth/authorize?request_id=req-1');
  await unmount(renderer);
});

test('a remembered approval without a redirect falls back to the Allow screen with the error', async () => {
  consentRequest = { client_name: 'Test App', scopes: ['profile'], remembered: true };
  workspaces = [];
  submitResult = async () => ({});
  const renderer = await render();
  expect(submits).toEqual([{ requestId: 'req-1', approved: true }]);
  expect(textOf(renderer)).toContain('Authorize Test App');
  expect(textOf(renderer)).toContain('The authorization did not return a redirect.');
  await unmount(renderer);
});
