import { expect, test } from 'bun:test';
import { SANDBOX_RATES, setupGuide } from '@kortix/shared/setup-guide';
import { getProviderComputeRateCard } from '../platform/providers/compute-rates';

// /setup.md quotes what a session sandbox costs so the setup agent can size it.
// Billing owns the rates: the guide's numbers must be the billed ones.
test('the setup guide quotes the sandbox rates billing charges', () => {
  const card = getProviderComputeRateCard('platinum');
  expect(SANDBOX_RATES.vcpuHour).toBeCloseTo(card.cpuPerCoreSecond * 3600, 8);
  expect(SANDBOX_RATES.memoryGbHour).toBeCloseTo(card.memoryPerGbSecond * 3600, 8);
  expect(SANDBOX_RATES.diskGbMonth).toBeCloseTo(card.diskPerGbSecond * 3600 * 730, 8);
  const guide = setupGuide();
  expect(guide).toContain(`$${SANDBOX_RATES.vcpuHour} per`);
  expect(guide).toContain(`$${SANDBOX_RATES.memoryGbHour} per GB-hour`);
});
