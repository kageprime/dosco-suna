// A caller without `billing.read` gets the gating view of the account state.
// The credit amounts are absent (never zero), and `hidden`
// names the constraint and the remedy. Before, the view sent only `can_run`
// and the CLI decorated it with a units map for fields that were not there.
import { describe, expect, test } from 'bun:test';
import type { AccountStateResponse } from '../../types';
import { gatingView, hiddenCredits } from './account-state';

const STATE = {
  model_access: 'full',
  billing_state: 'active',
  has_active_subscription: true,
  plan: { key: 'credits', family: 'credits', label: 'Credits', monthly_usd: 20 },
  credits: { total: 42.5, daily: 0, monthly: 12, extra: 30.5, lifetime_used: 9, can_run: true },
  subscription: { tier_key: 'credits', tier_display_name: 'Credits', status: 'active' },
  tier: { name: 'credits', display_name: 'Credits', entitlements: {} },
  enterprise_license_available: false,
  enterprise_entitled: false,
  enterprise: null,
  grace: null,
} as unknown as AccountStateResponse;

describe('gatingView', () => {
  test('credit amounts are explicit nulls with the reason; no balance leaks', () => {
    const view = gatingView(STATE, 'token_account_shared');
    expect(view.credits.can_run).toBe(true);
    for (const key of ['total', 'daily', 'monthly', 'extra']) expect(key in view.credits).toBe(false);
    expect(view.credits.hidden.reason).toBe('token_account_shared');
    expect(view.credits.hidden.message).toContain('kortix login');
    expect(JSON.stringify(view)).not.toContain('42.5');
    expect(JSON.stringify(view)).not.toContain('lifetime_used');
    expect(view.plan?.monthly_usd).toBeNull();
  });

  test('a role denial names billing.read and who grants it', () => {
    const hidden = hiddenCredits('account_role_insufficient').hidden;
    expect(hidden.reason).toBe('account_role_insufficient');
    expect(hidden.message).toContain('billing.read');
    expect(hidden.message).toContain('Settings → People');
  });

  test('an unknown reason still says why', () => {
    expect(hiddenCredits(undefined).hidden.reason).toBe('billing_read_required');
  });
});
