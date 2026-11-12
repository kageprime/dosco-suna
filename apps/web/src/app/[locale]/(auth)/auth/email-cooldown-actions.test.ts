import { beforeEach, expect, mock, test } from 'bun:test';
import { createTranslator } from 'next-intl';
import messages from '../../../../../translations/en.json';

// One auth email per address per minute. The window is enforced server-side on
// the API's email-sending routes and, for the web forms, remembered in this
// browser's own session cookie (`markAuthEmailSent`): inside the window, a
// re-submit answers "already sent" with the seconds left and does not call
// GoTrue, which would mail an unconfirmed address again on every signUp. The
// site deliberately does not expose the window on the anonymous check-email
// (KRTX-3504): a triggered send plus that answer would re-open the
// account-existence oracle the issue closed.

const translator = createTranslator({ locale: 'en', messages, namespace: 'hardcodedUi.i18nComplete' });
let check: Record<string, unknown> = { allowed: true };
let signInError: { code?: string; message: string; status?: number } | null = null;
const signUp = mock(async (_input: unknown) => ({ data: { user: null, session: null }, error: null }));
const signInWithOtp = mock(async (_input: unknown) => ({ error: null }));
const signInWithPassword = mock(async (_input: unknown) => ({
  data: signInError ? { user: null, session: null } : { user: { id: 'u1' }, session: { access_token: 'at', refresh_token: 'rt' } },
  error: signInError,
}));

// A real cookie store: `sendEmailCode` marks a delivered send in it and the
// re-submit reads the window back from it.
const cookieStore = new Map<string, string>();
mock.module('next/headers', () => ({
  headers: async () => new Headers(),
  cookies: async () => ({
    get: (key: string) => (cookieStore.has(key) ? { value: cookieStore.get(key) } : undefined),
    set: (cookie: { name: string; value: string }) => {
      if (setRefusesWrites) throw new Error('store refuses writes');
      cookieStore.set(cookie.name, cookie.value);
    },
    delete: (key: string) => {
      cookieStore.delete(key);
    },
  }),
}));
mock.module('@/lib/public-env-server', () => ({
  getServerPublicEnv: () => ({ APP_URL: 'http://localhost:13000', BACKEND_URL: 'http://localhost:8008/v1' }),
}));
mock.module('@/lib/auth/sign-out-actions', () => ({ clearAuthBounceCookie: async () => {} }));
mock.module('@kortix/sdk', () => ({ checkAccessEmail: async () => check, submitAccessRequest: async () => ({}) }));
mock.module('@/i18n/get-translations', () => ({ getTranslations: async () => translator }));
mock.module('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { signUp, signInWithOtp, signInWithPassword } }),
}));

const { sendEmailCode, signUpWithPassword } = await import('./actions');

const EMAIL = 'synthetic@example.test';
const SENT_COOKIE = 'kortix-auth-email-sent';

function form() {
  const data = new FormData();
  data.set('email', EMAIL);
  data.set('password', 'synthetic-password');
  data.set('confirmPassword', 'synthetic-password');
  data.set('origin', 'http://localhost:13000');
  return data;
}

const NOT_CONFIRMED = { code: 'email_not_confirmed', message: 'Email not confirmed', status: 400 };
let setRefusesWrites = false;

function coolDown(elapsedSeconds: number) {
  cookieStore.set(SENT_COOKIE, `${EMAIL}|${Date.now() - elapsedSeconds * 1000}`);
}

beforeEach(() => {
  check = { allowed: true };
  signInError = null;
  signUp.mockClear();
  signInWithOtp.mockClear();
  signInWithPassword.mockClear();
  cookieStore.clear();
  setRefusesWrites = false;
});

test('a delivered email-link send starts the window in the session cookie', async () => {
  await sendEmailCode(null, form());
  expect(signInWithOtp).toHaveBeenCalledTimes(1);
  const [email, sentAtRaw] = (cookieStore.get(SENT_COOKIE) ?? '').split('|');
  expect(email).toBe(EMAIL);
  expect(Number.isFinite(Number(sentAtRaw))).toBe(true);
});

test('email link inside the window answers the link step without a GoTrue send', async () => {
  coolDown(20);
  const result = await sendEmailCode(null, form());
  expect(signInWithOtp).not.toHaveBeenCalled();
  expect(result).toMatchObject({
    success: true,
    alreadySent: true,
    retryAfterSeconds: 40,
    email: EMAIL,
    mode: 'unknown',
    message: translator.raw('authEmailAlreadySent'),
  });
});

test('another address is not cool for this browser because another one was', async () => {
  coolDown(0);
  const data = form();
  data.set('email', 'other@example.test');
  await sendEmailCode(null, data);
  expect(signInWithOtp).toHaveBeenCalledTimes(1);
  const [email] = (cookieStore.get(SENT_COOKIE) ?? '').split('|');
  expect(email).toBe('other@example.test');
});

test('email link outside the window sends once and marks it', async () => {
  coolDown(61);
  const result = await sendEmailCode(null, form());
  expect(signInWithOtp).toHaveBeenCalledTimes(1);
  expect(result).toMatchObject({ success: true, retryAfterSeconds: 60 });
  expect(result).not.toHaveProperty('alreadySent');
  expect(cookieStore.has(SENT_COOKIE)).toBe(true);
});

test('password signup inside the window does not mail the address again', async () => {
  coolDown(42);
  signInError = NOT_CONFIRMED;
  const result = await signUpWithPassword(null, form());
  expect(signUp).not.toHaveBeenCalled();
  expect(result).toMatchObject({
    success: true,
    requiresEmailConfirmation: true,
    alreadySent: true,
    retryAfterSeconds: 18,
    message: translator.raw('authEmailAlreadySent'),
  });
});

test('password signup inside the window still signs a confirmed account in', async () => {
  coolDown(42);
  const result = await signUpWithPassword(null, form());
  expect(signUp).not.toHaveBeenCalled();
  expect(result).toMatchObject({ success: true, accessToken: 'at' });
});

test('password signup inside the window with a wrong password reads as an existing account', async () => {
  coolDown(42);
  signInError = { code: 'invalid_credentials', message: 'Invalid login credentials', status: 400 };
  expect(await signUpWithPassword(null, form())).toMatchObject({ code: 'existing_account_wrong_password' });
});

test('a first password signup sends once, marks the window and starts the countdown', async () => {
  signInError = NOT_CONFIRMED;
  const result = await signUpWithPassword(null, form());
  expect(signUp).toHaveBeenCalledTimes(1);
  expect(result).toMatchObject({ requiresEmailConfirmation: true, alreadySent: false, retryAfterSeconds: 60 });
  expect(cookieStore.has(SENT_COOKIE)).toBe(true);
});

test('a cookie store that refuses writes only loses the skip', async () => {
  setRefusesWrites = true;
  signInError = NOT_CONFIRMED;
  const result = await signUpWithPassword(null, form());
  expect(result).toMatchObject({ success: true, requiresEmailConfirmation: true });
});
