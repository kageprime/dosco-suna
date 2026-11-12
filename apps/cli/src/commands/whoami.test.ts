import { expect, test } from 'bun:test';
import type { Auth } from '../api/auth.ts';
import type { AccountMembership, MeResponse } from '../api/types.ts';
import { boundedAccounts, renderWhoamiJson, WHOAMI_ACCOUNTS_CAP, WHOAMI_JSON_MAX_BYTES } from './whoami.ts';

const membership = (i: number): AccountMembership => ({ account_id: `acct-${i}`, slug: `s${i}`, name: `A ${i}`, role: 'member' });

const AUTH: Auth = { api_base: 'http://api.test/v1', token: 't', user_id: 'u', user_email: 'e@x', account_id: 'acct-1', logged_in_at: '2026-01-01T00:00:00.000Z' };
const ME = (accounts: AccountMembership[]): MeResponse => ({ user_id: 'u', email: 'e@x', accounts });

// The MCP tool captures stdout at 45 000 bytes (`STDOUT_CAP` in apps/api/src/mcp/cli.ts)
// and a cut capture is not valid JSON at all, so `--json` output must stay whole
// inside it (the ke2e MCP-6 flow, 2026-11-09 release gate). Names are UTF-8
// multi-byte and up to 255 chars (the server's varchar(255)), so the accounts
// list is bounded twice over: entry count first, then serialized bytes.
test('whoami --json: bytes, not entries, are the real ceiling', () => {
  const wide = (i: number): AccountMembership => ({ ...membership(i), name: '\u{1F600}'.repeat(255) });
  const me800 = Array.from({ length: 800 }, (_, i) => wide(i));
  const active = me800[1];
  const full = renderWhoamiJson(ME(me800), AUTH, null, active, null);
  expect(Buffer.byteLength(full, 'utf8')).toBeLessThanOrEqual(WHOAMI_JSON_MAX_BYTES);
  // Even the count cap alone (50 entries) hands the widest valid names a
  // serialized size past the capture: the byte bound must cut further.
  const capped = renderWhoamiJson(ME(Array.from({ length: 50 }, (_, i) => wide(i))), AUTH, null, active, null);
  expect(Buffer.byteLength(capped, 'utf8')).toBeLessThanOrEqual(WHOAMI_JSON_MAX_BYTES);
  expect(JSON.parse(capped).accounts.length).toBeLessThan(50);
});

test('whoami --json bounds the accounts list: active first, whole payload, total only when cut', () => {
  const many = Array.from({ length: 800 }, (_, i) => membership(i));
  const active = many[700]!;
  const text = renderWhoamiJson(ME(many), AUTH, null, active, null);
  const parsed = JSON.parse(text) as { accounts: AccountMembership[]; accounts_total: number };
  expect(parsed.accounts.length).toBeLessThanOrEqual(WHOAMI_ACCOUNTS_CAP);
  expect(parsed.accounts[0]!.account_id).toBe('acct-700');
  expect(parsed.accounts_total).toBe(800);
  expect(parsed.accounts.filter((a) => a.account_id === 'acct-700')).toHaveLength(1);
});

test('a user under the cap keeps every account and no total field', () => {
  const few = [membership(0), membership(1), membership(2)];
  const text = renderWhoamiJson(ME(few), AUTH, null, few[1], null);
  const parsed = JSON.parse(text) as { accounts: AccountMembership[]; accounts_total?: number };
  expect(parsed.accounts.map((a) => a.account_id)).toEqual(['acct-1', 'acct-0', 'acct-2']);
  expect('accounts_total' in parsed).toBe(false);
});

test('the entry cap alone holds for ordinary names', () => {
  const exact = Array.from({ length: WHOAMI_ACCOUNTS_CAP }, (_, i) => membership(i));
  const ordered = boundedAccounts(exact, exact[5]);
  expect(ordered).toHaveLength(WHOAMI_ACCOUNTS_CAP);
  expect(ordered[0]!.account_id).toBe('acct-5');
});
