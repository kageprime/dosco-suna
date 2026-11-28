import { NextIntlClientProvider } from '@/i18n/use-translations';
import { afterEach, expect, mock, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import messages from '../../../../../translations/en.json';

/**
 * KRTX-1978: a session that ends (refresh refused, revoked, signed out in
 * another tab) bounces to `/auth?redirect=…&reason=session_ended`. The form
 * must say why the user is there, instead of the blank welcome a first-time
 * visitor sees. A session the page can still restore never shows it.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
Object.defineProperty(globalThis, 'window', {
  value: { location: { origin: 'http://localhost' } },
  configurable: true,
});
let search = new URLSearchParams();
type AuthState = { isLoading: boolean; bootstrapError: Error | null };
const signedOut: AuthState = { isLoading: false, bootstrapError: null };
let auth: AuthState = { ...signedOut };
mock.module('next/navigation', () => ({
  useRouter: () => ({ replace: () => {}, push: () => {} }),
  usePathname: () => '/auth',
  useParams: () => ({}),
  useSearchParams: () => search,
}));
mock.module('@/features/providers/auth-provider', () => ({
  useAuth: () => ({ user: null, session: null, supabase: {}, ...auth }),
}));
mock.module('@/lib/supabase/client', () => ({
  fetchSamlEnabled: async () => false,
  createClient: () => ({ auth: {} }),
}));
mock.module('./actions', () => ({
  resolveAuthMode: async () => ({ mode: 'unknown' }),
  sendEmailCode: async () => ({ success: true }),
}));
mock.module('@/lib/env-config', () => ({
  getEnv: () => ({ AUTH_METHODS: 'magic,password', AUTH_PROVIDERS: '' }),
}));
mock.module('@kortix/ui/toast', () => ({ errorToast: () => {} }));
const { default: AuthPage } = await import('./page');

const NOTICE = messages.auth.unified.sessionEnded;
let tree: ReactTestRenderer | undefined;
afterEach(async () => {
  await act(async () => tree?.unmount());
  tree = undefined;
  search = new URLSearchParams();
  auth = { ...signedOut };
});

async function renderedText(query: string): Promise<string> {
  search = new URLSearchParams(query);
  await act(async () => {
    tree = create(
      <NextIntlClientProvider locale="en" messages={messages}>
        <AuthPage />
      </NextIntlClientProvider>,
    );
  });
  return JSON.stringify(tree?.toJSON());
}

test('explains a session that ended once the session check finds none', async () => {
  expect(await renderedText('redirect=%2Fworkspaces&reason=session_ended')).toContain(NOTICE);
});

test('says nothing while the session check may still restore the session', async () => {
  auth.isLoading = true;
  expect(await renderedText('redirect=%2Fworkspaces&reason=session_ended')).not.toContain(NOTICE);
});

test('an auth check that never answered is no verdict, so it says nothing', async () => {
  auth.bootstrapError = new Error('Authentication is not responding.');
  expect(await renderedText('redirect=%2Fworkspaces&reason=session_ended')).not.toContain(NOTICE);
});

test('a visitor who never had a session sees the plain form', async () => {
  expect(await renderedText('redirect=%2Fworkspaces')).not.toContain(NOTICE);
});
