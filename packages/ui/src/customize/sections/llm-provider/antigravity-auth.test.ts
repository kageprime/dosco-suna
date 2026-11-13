import { describe, expect, test } from 'bun:test';
import { parseAntigravityAuth } from './antigravity-auth';

// The UI parser must accept exactly what the API contract accepts: a ya29
// bearer or an OAuth JSON with a token, and nothing else. An API key used to
// pass here, was stored as a bearer with a one-year lifetime, and then failed
// every model call (2026-11-13).
describe('parseAntigravityAuth', () => {
  test('a ya29 bearer is accepted with a 50-minute lifetime', () => {
    const parsed = parseAntigravityAuth('ya29.a0AfH6SMC1234567890abcdefghijklmnop');
    expect(parsed?.access).toStartWith('ya29.');
    expect(parsed?.expires).toBeGreaterThan(Date.now() + 49 * 60 * 1000);
    expect(parsed?.expires).toBeLessThan(Date.now() + 51 * 60 * 1000);
  });

  test('an API key is rejected', () => {
    expect(parseAntigravityAuth('AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ1234567')).toBeNull();
  });

  test('arbitrary text is rejected', () => {
    expect(parseAntigravityAuth('hello world')).toBeNull();
  });

  test('a wrapped JSON keeps its Cloud Code project', () => {
    const parsed = parseAntigravityAuth(
      JSON.stringify({ antigravity: { access: 'ya29.x', refresh: '1//r', project: 'proj-1' } }),
    );
    expect(parsed).toMatchObject({ access: 'ya29.x', refresh: '1//r', project: 'proj-1' });
  });
});