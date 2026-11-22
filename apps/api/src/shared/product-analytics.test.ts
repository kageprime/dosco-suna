import { expect, test } from 'bun:test';

import { isStaffEmail } from './product-analytics';

// A staff person is hidden from every PostHog dashboard; a customer must never be.
test('only an address on a Kortix domain is staff', () => {
  for (const email of ['agent@kortix.ai', 'agent@kortix.com', 'Agent@Kortix.AI', 'agent+test@kortix.ai']) {
    expect(isStaffEmail(email)).toBe(true);
  }
  for (const email of [
    'agent@example.test',
    'agent@notkortix.ai',
    'agent@kortix.ai.example.test',
    'kortix.ai@example.test',
    'agent@mail.kortix.ai',
    '@kortix.ai',
    '',
    null,
    undefined,
  ]) {
    expect(isStaffEmail(email)).toBe(false);
  }
});
