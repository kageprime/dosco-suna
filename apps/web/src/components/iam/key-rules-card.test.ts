import { describe, expect, test } from 'bun:test';

import type { PatPolicy } from '@/lib/iam-client';
import { policyIdentity } from './key-rules-card';

/**
 * The rules form's field rules (blank, whole number, cap) moved to the shared
 * parser (`optional-int-field.test.ts` pins them, same cases and sentences).
 * What stays here is the key the form remounts by.
 */

/**
 * The form is seeded from props and remounted by this key, so a stale key
 * means a save that appears not to stick: the fields would keep showing what
 * was typed before the server answered. Every field must move it.
 */
describe('policyIdentity', () => {
  const base: PatPolicy = {
    require_expiry: false,
    max_lifetime_days: null,
    idle_revoke_days: null,
  };

  test('is stable for the same saved policy', () => {
    expect(policyIdentity(base)).toBe(policyIdentity({ ...base }));
  });

  test('changes when any one field changes', () => {
    const identity = policyIdentity(base);
    expect(policyIdentity({ ...base, require_expiry: true })).not.toBe(identity);
    expect(policyIdentity({ ...base, max_lifetime_days: 90 })).not.toBe(identity);
    expect(policyIdentity({ ...base, idle_revoke_days: 30 })).not.toBe(identity);
  });

  test('distinguishes the two day fields — 90/null is not null/90', () => {
    expect(policyIdentity({ ...base, max_lifetime_days: 90 })).not.toBe(
      policyIdentity({ ...base, idle_revoke_days: 90 }),
    );
  });
});
