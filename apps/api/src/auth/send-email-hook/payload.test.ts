import { describe, expect, test } from 'bun:test';

import { buildVerifyUrl, parseSendEmailHookPayload } from './payload';

const BASE = 'https://supa.example.com';

function payload(overrides: Record<string, unknown> = {}) {
  return {
    user: { email: 'user@example.test' },
    email_data: {
      token: '123456',
      token_hash: 'hash-abc',
      redirect_to: 'https://app.example.com/dashboard',
      email_action_type: 'magiclink',
      site_url: 'https://app.example.com',
      ...overrides,
    },
  };
}

describe('parseSendEmailHookPayload', () => {
  test('builds the GoTrue verify link for a magic link', () => {
    const result = parseSendEmailHookPayload(payload(), BASE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.email.recipient).toBe('user@example.test');
    expect(result.email.actionType).toBe('magiclink');
    expect(result.email.actionUrl).toBe(
      'https://supa.example.com/auth/v1/verify?token=hash-abc&type=magiclink&redirect_to=https%3A%2F%2Fapp.example.com%2Fdashboard',
    );
  });

  test('every GoTrue action type is handled', () => {
    for (const type of [
      'signup',
      'invite',
      'magiclink',
      'recovery',
      'email_change',
      'email_change_current',
    ]) {
      const result = parseSendEmailHookPayload(payload({ email_action_type: type }), BASE);
      expect(result.ok).toBe(true);
    }
  });

  test('email_change_new addresses the NEW mailbox with its own token', () => {
    const result = parseSendEmailHookPayload(
      {
        user: { email: 'old@example.test', new_email: 'new@example.test' },
        email_data: {
          email_action_type: 'email_change_new',
          token_hash: 'old-hash',
          token_hash_new: 'new-hash',
          token: '111111',
          token_new: '222222',
        },
      },
      BASE,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.email.recipient).toBe('new@example.test');
    expect(result.email.actionUrl).toContain('token=new-hash');
  });

  test('reauthentication carries a code and no link', () => {
    const result = parseSendEmailHookPayload(
      payload({ email_action_type: 'reauthentication', token_hash: '' }),
      BASE,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.email.token).toBe('123456');
    expect(result.email.actionUrl).toBe('');
  });

  test('falls back to site_url when no explicit redirect_to is given', () => {
    const result = parseSendEmailHookPayload(payload({ redirect_to: '' }), BASE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.email.actionUrl).toContain('redirect_to=https%3A%2F%2Fapp.example.com');
  });

  // GoTrue's verify endpoint answers a PKCE signup with a code that expires 5
  // minutes after the signup started; the callback verifies the hash itself.
  test('a signup confirmation links straight to the web callback with the token hash', () => {
    for (const path of ['/auth/callback', '/auth/mobile/callback']) {
      const result = parseSendEmailHookPayload(
        payload({
          email_action_type: 'signup',
          token_hash: 'pkce_hash-abc',
          redirect_to: `https://app.example.com${path}?returnUrl=%2Fworkspaces%2Fstart&terms_accepted=true`,
        }),
        BASE,
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.email.actionUrl).toBe(
        `https://app.example.com${path}?returnUrl=%2Fworkspaces%2Fstart&terms_accepted=true&token_hash=pkce_hash-abc&type=signup`,
      );
    }
  });

  test('a signup with any other redirect target keeps the GoTrue verify link', () => {
    for (const redirect_to of ['https://app.example.com/dashboard', 'kortix://auth/callback', '']) {
      const result = parseSendEmailHookPayload(
        payload({ email_action_type: 'signup', redirect_to, site_url: '' }),
        BASE,
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.email.actionUrl.startsWith('https://supa.example.com/auth/v1/verify?token=hash-abc&type=signup')).toBe(true);
    }
  });

  test('a magic link to the web callback keeps the GoTrue verify link', () => {
    const result = parseSendEmailHookPayload(
      payload({ redirect_to: 'https://app.example.com/auth/callback?returnUrl=%2F' }),
      BASE,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.email.actionUrl.startsWith('https://supa.example.com/auth/v1/verify?token=hash-abc&type=magiclink')).toBe(true);
  });

  test('reports a precise reason for every malformed payload', () => {
    expect(parseSendEmailHookPayload({}, BASE)).toEqual({ ok: false, reason: 'missing email_data' });
    expect(parseSendEmailHookPayload(payload({ email_action_type: 'nope' }), BASE)).toMatchObject({
      ok: false,
      reason: expect.stringContaining('unsupported email_action_type'),
    });
    expect(
      parseSendEmailHookPayload({ email_data: { email_action_type: 'magiclink' } }, BASE),
    ).toEqual({ ok: false, reason: 'missing user email' });
    expect(parseSendEmailHookPayload(payload({ token_hash: '' }), BASE)).toEqual({
      ok: false,
      reason: 'missing token_hash',
    });
    // Self-host: SUPABASE_URL is an internal Docker hostname, so a link built
    // from it would be unreachable. Refuse rather than mail a dead link.
    expect(parseSendEmailHookPayload(payload(), '')).toEqual({
      ok: false,
      reason: 'no public Supabase URL configured',
    });
  });
});

describe('buildVerifyUrl', () => {
  test('normalizes a trailing slash on the base URL', () => {
    expect(
      buildVerifyUrl({ verifyBaseUrl: `${BASE}/`, tokenHash: 'h', actionType: 'recovery' }),
    ).toBe('https://supa.example.com/auth/v1/verify?token=h&type=recovery');
  });
});
