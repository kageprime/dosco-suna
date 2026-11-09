import { describe, expect, test } from 'bun:test';
import { clientAbortTarget, parseForkPath } from './client-abort';

// Every client that stops a turn — web, mobile, SDK, CLI — does it with one
// abort call through this proxy. It is the only place the control plane can
// learn that a stop was ASKED FOR before the turn ends.
describe('clientAbortTarget', () => {
  test('names the OpenCode session a client asked to abort', () => {
    expect(clientAbortTarget(8000, 'POST', '/session/ses_root/abort')).toBe('ses_root');
    expect(clientAbortTarget(8000, 'post', '/session/ses_root/abort/')).toBe('ses_root');
    expect(clientAbortTarget(8000, 'POST', '/session/ses%2Froot/abort')).toBe('ses/root');
  });

  test('is null for everything that is not that call', () => {
    expect(clientAbortTarget(8000, 'GET', '/session/ses_root/abort')).toBeNull();
    expect(clientAbortTarget(3000, 'POST', '/session/ses_root/abort')).toBeNull();
    expect(clientAbortTarget(8000, 'POST', '/session/ses_root/message')).toBeNull();
    expect(clientAbortTarget(8000, 'POST', '/session/ses_root/abort/after-tool')).toBeNull();
    // The daemon's OWN abort route is the control plane stopping a box, not a client.
    expect(clientAbortTarget(8000, 'POST', '/kortix/abort')).toBeNull();
    expect(clientAbortTarget(8000, 'POST', '/session//abort')).toBeNull();
  });

  test('a malformed escape is not an abort target', () => {
    expect(clientAbortTarget(8000, 'POST', '/session/%E0%A4%A/abort')).toBeNull();
  });
});

// KRTX-4477: both fork call sites (the stopped-sandbox gate and the record a
// successful fork registers) parse with this one predicate now, over the same
// shapes the old two regexes accepted — every in-box-prefixed, trailing-slash
// and query-tailed spelling included (the registration used to miss those).
describe('parseForkPath', () => {
  test('names the conversation every fork spelling starts from', () => {
    expect(parseForkPath(8000, 'POST', '/session/ses_root/fork')).toBe('ses_root');
    expect(parseForkPath(8000, 'POST', '/proxy/1/session/ses_root/fork')).toBe('ses_root');
    expect(parseForkPath(8000, 'POST', '/session/ses_root/fork/')).toBe('ses_root');
    expect(parseForkPath(4096, 'POST', '/session/ses_root/fork?after=1')).toBe('ses_root');
    expect(parseForkPath(8000, 'post', '/session/ses_root/fork')).toBe('ses_root');
  });

  test('is null for everything that is not a fork on a session-data port', () => {
    expect(parseForkPath(8000, 'GET', '/session/ses_root/fork')).toBeNull();
    expect(parseForkPath(3000, 'POST', '/session/ses_root/fork')).toBeNull();
    expect(parseForkPath(8000, 'POST', '/session/ses_root/fork/sub')).toBeNull();
    expect(parseForkPath(8000, 'POST', '/session/ses_root/message')).toBeNull();
    expect(parseForkPath(8000, 'POST', '/session//fork')).toBeNull();
  });
});
