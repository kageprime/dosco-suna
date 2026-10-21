import { describe, expect, test } from 'bun:test';

import { redirectSystemPath } from '@/app/+native-intent';
import { inviteIdFromUrl, rememberInviteLink, takeInviteLink } from './invite-landing';

const ID = '3f2b8c1e-9a4d-4e6f-8b2a-1c5d7e9f0a3b';

describe('inviteIdFromUrl — the invite links the app reads', () => {
  test('the web invite link on every Kortix host', () => {
    expect(inviteIdFromUrl(`https://dosco.live/invites/${ID}`)).toBe(ID);
    expect(inviteIdFromUrl(`https://www.dosco.live/invites/${ID}`)).toBe(ID);
    expect(inviteIdFromUrl(`https://staging.dosco.live/invites/${ID}`)).toBe(ID);
    expect(inviteIdFromUrl(`https://dosco.live/invites/${ID}?utm=mail#top`)).toBe(ID);
  });

  test('both forms of the app scheme', () => {
    expect(inviteIdFromUrl(`dosco://invites/${ID}`)).toBe(ID);
    expect(inviteIdFromUrl(`dosco:///invites/${ID}`)).toBe(ID);
  });

  test('an upper-case id comes back in lower case', () => {
    expect(inviteIdFromUrl(`dosco://invites/${ID.toUpperCase()}`)).toBe(ID);
  });

  test('not an invite link: null', () => {
    expect(inviteIdFromUrl(`https://evil.com/invites/${ID}`)).toBeNull();
    expect(inviteIdFromUrl(`https://dosco.live.evil.com/invites/${ID}`)).toBeNull();
    expect(inviteIdFromUrl(`http://dosco.live/invites/${ID}`)).toBeNull();
    expect(inviteIdFromUrl(`exp://127.0.0.1:8081/--/invites/${ID}`)).toBeNull();
    expect(inviteIdFromUrl('https://dosco.live/invites/')).toBeNull();
    expect(inviteIdFromUrl('dosco://invites')).toBeNull();
    expect(inviteIdFromUrl('https://dosco.live/invites/not-a-uuid')).toBeNull();
    expect(inviteIdFromUrl(`https://dosco.live/invites/${ID}/x`)).toBeNull();
    expect(inviteIdFromUrl(`https://dosco.live/share/${ID}`)).toBeNull();
    expect(inviteIdFromUrl(`/invites/${ID}`)).toBeNull();
    expect(inviteIdFromUrl('')).toBeNull();
  });
});

describe('the remembered invite link', () => {
  test('is taken once', () => {
    rememberInviteLink(ID);
    expect(takeInviteLink()).toBe(ID);
    expect(takeInviteLink()).toBeNull();
  });

  test('the newest link wins', () => {
    rememberInviteLink('a');
    rememberInviteLink(ID);
    expect(takeInviteLink()).toBe(ID);
  });

  test('an opened invite link routes unchanged and is kept for after sign-in', () => {
    takeInviteLink();
    expect(redirectSystemPath({ path: `dosco://invites/${ID}`, initial: true })).toBe(`dosco://invites/${ID}`);
    expect(takeInviteLink()).toBe(ID);
  });

  test('any other link is not kept', () => {
    redirectSystemPath({ path: 'dosco://share/abc', initial: false });
    redirectSystemPath({ path: '/projects/p1', initial: false });
    expect(takeInviteLink()).toBeNull();
  });
});
