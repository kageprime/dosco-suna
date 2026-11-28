import { createHash } from 'node:crypto';
import { beforeEach, expect, mock, test } from 'bun:test';
import { createTranslator } from 'next-intl';
import messages from '../../../../../translations/en.json';

const translator = createTranslator({ locale: 'en', messages, namespace: 'hardcodedUi.i18nComplete' });
let delivered = false;
let cookieFailure = false;
let translationFailureAfterDelivery = false;
let mode = 'signin';
let sendError: { code: string; message: string; status: number } | null = null;
const setCookie = mock((_key: string, _value: string, _options: unknown) => {});
const send = mock(async (_input: unknown) => {
  delivered = !sendError;
  return { error: sendError };
});
mock.module('next/headers', () => ({
  headers: async () => new Headers(),
  cookies: async () => {
    if (delivered && cookieFailure) throw new Error('cookie store unavailable');
    return { set: setCookie, get: (key: string) => key.endsWith('-code-verifier') ? { value: 'base64-synthetic' } : undefined };
  },
}));
mock.module('@/lib/public-env-server', () => ({
  getServerPublicEnv: () => ({ APP_URL: 'http://localhost:13000', BACKEND_URL: 'http://localhost:8008/v1' }),
}));
mock.module('@/lib/auth/sign-out-actions', () => ({ clearAuthBounceCookie: async () => {} }));
mock.module('@kortix/sdk', () => ({ checkAccessEmail: async () => ({ mode }), submitAccessRequest: async () => ({}) }));
mock.module('@/i18n/get-translations', () => ({ getTranslations: async () => ({
  raw: (key: Parameters<typeof translator.raw>[0]) => {
    if (delivered && translationFailureAfterDelivery) throw new Error('translation unavailable');
    return translator.raw(key);
  },
}) }));
const captured = mock((_message: string, _context: unknown) => {});
mock.module('@sentry/nextjs', () => ({ captureMessage: captured }));
mock.module('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { signInWithOtp: send } }) }));
const { sendEmailCode } = await import('./actions');
const form = () => {
  const data = new FormData();
  data.set('email', ' SYNTHETIC@example.test ');
  data.set('origin', 'http://localhost:13000');
  data.set('returnUrl', '/invites/synthetic');
  data.set('acceptedTerms', 'true');
  data.set('referralCode', ' synthetic ');
  return data;
};
beforeEach(() => {
  delivered = false; cookieFailure = false; translationFailureAfterDelivery = false;
  mode = 'unknown'; sendError = null; send.mockClear(); setCookie.mockClear(); captured.mockClear();
});
test('delivered send stays successful if the verifier cookie store fails', async () => {
  cookieFailure = true;
  expect(await sendEmailCode(null, form())).toMatchObject({ success: true, email: 'synthetic@example.test', codeVerifier: null, redirectTo: '/invites/synthetic' });
  expect(send).toHaveBeenCalledTimes(1);
});
test('success copy is resolved before delivery, so translation cannot undo a send', async () => {
  translationFailureAfterDelivery = true;
  expect(await sendEmailCode(null, form())).toMatchObject({ success: true, message: translator.raw('textd7eb7cdcff7d') });
});
test('keeps the PKCE fallback and normalized referral, terms and invite destination', async () => {
  expect(await sendEmailCode(null, form())).toMatchObject({ success: true, codeVerifier: 'base64-synthetic' });
  expect(send).toHaveBeenCalledWith({ email: 'synthetic@example.test', options: {
    emailRedirectTo: 'http://localhost:13000/auth/callback?returnUrl=%2Finvites%2Fsynthetic&terms_accepted=true',
    shouldCreateUser: true, data: { referral_code: 'SYNTHETIC' },
  } });
});
for (const error of [
  { code: 'email_address_invalid', message: 'Invalid email address', status: 400 },
  { code: 'timeout', message: 'Delivery is unknown', status: 503 },
  { code: 'over_email_send_rate_limit', message: 'Email rate limit exceeded', status: 429 },
]) {
  test(`upstream ${error.code} never reports success`, async () => {
    sendError = error;
    const result = await sendEmailCode(null, form());
    expect(result).not.toHaveProperty('success', true);
    expect(result).toHaveProperty('status', error.status);
    expect(result.message).toBeTruthy();
  });
}
test('sso blocks delivery', async () => {
  mode = 'sso';
  expect(await sendEmailCode(null, form())).not.toHaveProperty('success', true);
  expect(send).not.toHaveBeenCalled();
});

// KRTX-3504: the public API answers `closed` for every address on a closed
// deployment — it can no longer say who holds an account — so the send must
// still go out (an existing passwordless account signs in through this link)
// with `shouldCreateUser: false` (GoTrue mints nothing), and every non-429
// failure must answer the same neutral body as success: GoTrue's not-found
// for an unknown address must not become this action's fresh existence
// oracle. Only the shared rate limit still surfaces — per-IP pressure says
// nothing about the address, and hiding it would invite blind retries.
test('a closed-signup send still goes out, with shouldCreateUser:false', async () => {
  mode = 'closed';
  expect(await sendEmailCode(null, form())).toMatchObject({ success: true, mode: 'closed', email: 'synthetic@example.test' });
  expect(send).toHaveBeenCalledWith({ email: 'synthetic@example.test', options: expect.objectContaining({ shouldCreateUser: false }) });
});
test('an open-signup send keeps shouldCreateUser:true', async () => {
  mode = 'unknown';
  await sendEmailCode(null, form());
  expect(send).toHaveBeenCalledWith({ email: 'synthetic@example.test', options: expect.objectContaining({ shouldCreateUser: true }) });
});
for (const error of [
  { code: 'email_address_invalid', message: 'Invalid email address', status: 400 },
  { code: 'timeout', message: 'Delivery is unknown', status: 503 },
]) {
  test(`closed-signup upstream ${error.code} answers the same neutral body as success`, async () => {
    mode = 'closed';
    sendError = error;
    const neutral = await sendEmailCode(null, form());
    expect(neutral).toMatchObject({ success: true, mode: 'closed', email: 'synthetic@example.test' });
    expect(neutral).not.toHaveProperty('status');
    sendError = null;
    const success = await sendEmailCode(null, form());
    expect(neutral).toEqual(success);
  });
}
test('a closed-signup rate limit still surfaces', async () => {
  mode = 'closed';
  sendError = { code: 'over_email_send_rate_limit', message: 'Email rate limit exceeded', status: 429 };
  const result = await sendEmailCode(null, form());
  expect(result).not.toHaveProperty('success', true);
  expect(result).toHaveProperty('status', 429);
});
test('a closed-signup 429 whose code the copy helper does not know still surfaces', async () => {
  // GoTrue maps its own 429s to `over_request_rate_limit`, but a 429 can also
  // arrive from a proxy or a newer GoTrue with a body `authRateLimitCopy`
  // cannot match (no `over_*_rate_limit` code, no "rate limit" in the
  // message). The neutral swallow must key on the STATUS, so the visitor
  // still gets the backoff — with status 429, which arms the resend cooldown
  // — instead of a delivery promise no mail will keep.
  mode = 'closed';
  sendError = { code: 'too_many_requests', message: 'Slow down', status: 429 };
  const result = await sendEmailCode(null, form());
  expect(result).not.toHaveProperty('success', true);
  expect(result).toHaveProperty('status', 429);
});
test('a rejected transport does not fabricate delivery success', async () => {
  send.mockImplementationOnce(async () => { throw new Error('transport failed'); });
  await expect(sendEmailCode(null, form())).rejects.toThrow('transport failed');
});

test('mobile signup binds the emailed callback to a private browser cookie', async () => {
  const input = form();
  input.set('mobileCallback', 'true');
  input.set('mobileCallbackState', 'synthetic-mobile-state');
  expect(await sendEmailCode(null, input)).toMatchObject({ success: true });
  expect(setCookie).toHaveBeenCalledWith(
    expect.stringContaining('-mobile-signup'),
    expect.any(String),
    expect.objectContaining({ httpOnly: true }),
  );
  const [name, secret, options] = setCookie.mock.calls[0];
  expect(name).toEndWith('-mobile-signup');
  expect(secret).toHaveLength(64);
  expect(options).toEqual({
    httpOnly: true,
    secure: false,
    sameSite: 'lax',
    path: '/auth/mobile/callback',
    maxAge: 86400,
  });
  expect(send).toHaveBeenCalledWith(
    expect.objectContaining({
      options: expect.objectContaining({
        emailRedirectTo: expect.stringContaining(
          `browser_binding=${createHash('sha256').update(secret).digest('hex')}`,
        ),
      }),
    }),
  );
  expect(JSON.stringify(send.mock.calls)).not.toContain(secret);
});

// KRTX-3753: when the SMTP relay refuses (a provider quota), GoTrue answers
// 500 "Error sending confirmation email". That is an outage, not a bad
// address: it must answer 503 and reach Better Stack, or the infra sweep
// sees nothing and only a synthetic signup notices.
const deliveryFailure = { code: 'unexpected_failure', message: 'Error sending confirmation email', status: 500 };
const reported = { level: 'error', tags: { auth_error_code: 'unexpected_failure', auth_error_status: 500 } };
test('an upstream mail delivery failure answers 503 and reports the class at error level', async () => {
  sendError = deliveryFailure;
  const result = await sendEmailCode(null, form());
  expect(result).toMatchObject({ status: 503, message: deliveryFailure.message });
  expect(captured).toHaveBeenCalledWith('[auth] email send failed', reported);
  expect(JSON.stringify(captured.mock.calls)).not.toContain('synthetic@example.test');
});
test('a closed-signup delivery failure keeps the neutral body and still reports', async () => {
  mode = 'closed';
  sendError = deliveryFailure;
  expect(await sendEmailCode(null, form())).toMatchObject({ success: true, mode: 'closed' });
  expect(captured).toHaveBeenCalledWith('[auth] email send failed', reported);
});
test('a client-side refusal is not reported as a mail outage', async () => {
  sendError = { code: 'email_address_invalid', message: 'Invalid email address', status: 400 };
  expect(await sendEmailCode(null, form())).toHaveProperty('status', 400);
  expect(captured).not.toHaveBeenCalled();
});
