/**
 * The second factor an App cookie records, from `access-session` to the viewer
 * token mint.
 *
 * A viewer token counts as MFA-verified only when the cookie it was minted from
 * was opened by a browser session at aal2. A cookie opened without it (before
 * the account required MFA, or for a PAT or agent session token) never gains it
 * (Strix review of #12419). A renewal drops it, so the level lasts at most the
 * 8 h of the redeemed cookie (Strix review of #12423, 2026-11-11).
 */
import { describe, expect, test } from 'bun:test';
import { appAccessCookieName, appAccessSecret, appAccessSessionUrl, createAppAccessToken, verifyAppAccessToken } from './access';
import { appViewerSessionAal, authorizeAppRequest, renewedAppAccessCookie } from './public-proxy-access';

const APP_ID = '00000000-0000-4000-a000-0000000000b1';
const VIEWER = '00000000-0000-4000-a000-0000000000b2';
const OTHER = '00000000-0000-4000-a000-0000000000b3';
const app = { appId: APP_ID, accessMode: 'public', accessRevision: 3, projectId: '00000000-0000-4000-a000-0000000000b4' } as never;
const origin = 'https://dev-crm-0123456789abcdef.apps.kortix.com';
const now = new Date('2026-11-11T12:00:00Z');

const cookieValue = (aal?: 'aal2', over: { userId?: string; revision?: number; expiresAt?: Date } = {}) =>
  createAppAccessToken(
    { appId: APP_ID, kind: 'kortix', userId: VIEWER, aal, revision: 3, expiresAt: new Date(Date.now() + 3600_000), ...over },
    appAccessSecret(),
  );
const withCookie = (value: string, path = '/') =>
  new Request(`${origin}${path}`, { headers: { cookie: `${appAccessCookieName(false)}=${value}` } });
const payloadOf = (setCookie: string | null) =>
  verifyAppAccessToken(setCookie!.split(';')[0]!.split('=').slice(1).join('='), APP_ID, appAccessSecret(), now)!;

describe('the App cookie records the second factor of the session that opened it', () => {
  test('access-session marks the link only when asked to; redeeming keeps exactly that', async () => {
    for (const aal of ['aal2', undefined] as const) {
      const link = new URL(appAccessSessionUrl(`${origin}/`, { appId: APP_ID, accessRevision: 3 }, VIEWER, new Date(), aal).url);
      expect(verifyAppAccessToken(link.searchParams.get('__kortix_access')!, APP_ID)?.aal).toBe(aal);
      const redeemed = await authorizeAppRequest(new Request(link), link, app, async () => true);
      expect(redeemed?.status).toBe(303);
      expect(payloadOf(redeemed!.headers.get('set-cookie')).aal).toBe(aal);
    }
  });

  test('the viewer token gets aal2 only from a cookie that records it, for the viewer it names', () => {
    const url = new URL(`${origin}/_kortix/viewer`);
    expect(appViewerSessionAal(withCookie(cookieValue('aal2')), url, app, VIEWER)).toBe('aal2');
    expect(appViewerSessionAal(withCookie(cookieValue()), url, app, VIEWER)).toBeUndefined();
    // A bearer credential named someone else; the cookie's level is not theirs.
    expect(appViewerSessionAal(withCookie(cookieValue('aal2')), url, app, OTHER)).toBeUndefined();
    // An access-policy save (revision bump) ends the cookie and its level.
    expect(appViewerSessionAal(withCookie(cookieValue('aal2', { revision: 2 })), url, app, VIEWER)).toBeUndefined();
    expect(appViewerSessionAal(new Request(url), url, app, VIEWER)).toBeUndefined();
  });

  test('a renewal drops the level, so it never outlives the redeemed cookie', () => {
    const url = new URL(`${origin}/_kortix/token`);
    const halfSpent = new Date(now.getTime() + 2 * 3600_000);
    const renewed = (aal?: 'aal2') =>
      payloadOf(renewedAppAccessCookie(withCookie(cookieValue(aal, { expiresAt: halfSpent })), url, app, VIEWER, now));
    expect(renewed('aal2').aal).toBeUndefined();
    expect(renewed('aal2').userId).toBe(VIEWER);
    expect(renewed().aal).toBeUndefined();
  });
});
