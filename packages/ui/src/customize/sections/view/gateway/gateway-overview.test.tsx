import { expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
let estimate: number | null = 0.00205;
let overviewOverride: Record<string, unknown> | null = null;
mock.module('@kortix/sdk/react', () => ({
  useGatewayOverview: () => ({ data: overviewOverride ?? { requests: 1, errors: 0, total_cost: 0, estimated_usage_value: estimate, priced_requests: estimate === null ? 0 : 1, unpriced_requests: estimate === null ? 1 : 0, valuation: { coverage: 'LLM only. Subscription fee unknown.', rate_version: 'v1' } } }),
  useGatewayBreakdown: () => ({ data: { models: [] } }),
  useGatewaySeries: () => ({ data: { series: [] } }),
  useGatewaySessions: () => ({ data: { sessions: [] } }),
  useGatewayErrors: () => ({ data: { errors: [] } }),
  useGatewayBudgets: () => ({ data: undefined }),
  useSetGatewayBudget: () => ({ mutate() {} }),
  useDeleteGatewayBudget: () => ({ mutate() {} }),
  qk: { project: { sessions: () => ['sessions'] } },
  contract: () => ({}),
}));
const { GatewayOverview, usd2 } = await import('./gateway-overview');
function html() {
  return renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}><GatewayOverview projectId="synthetic" /></QueryClientProvider>);
}
function text() {
  return html().replace(/<[^>]+>/g, ' ').replace(/&lt;/g, '<').replace(/\s+/g, ' ');
}
test('retail estimate is visible, labelled not a bill, and a sub-cent value never reads as zero', () => {
  expect(text()).toContain('LLM estimated usage value (not a bill): <$0.01 · 1 priced requests');
  // The server's coverage prose and rate id are not on the page; they sit
  // behind the info icon, localized.
  expect(text()).not.toContain('Subscription fee unknown');
  expect(text()).not.toContain(' v1 ');
  expect(html()).toContain('aria-label="About this estimate"');
});
test('missing pricing is Unknown, not a zero estimate', () => {
  estimate = null;
  expect(text()).toContain('LLM estimated usage value (not a bill): Unknown · 0 priced requests');
  expect(text()).toContain('1 unpriced requests');
});
test('the estimate buckets add up to the Requests headline: priced + unpriced + failed', () => {
  overviewOverride = {
    requests: 2569,
    errors: 5,
    total_cost: 0,
    estimated_usage_value: 10.8045,
    priced_requests: 188,
    unpriced_requests: 2376,
    valuation: { coverage: 'LLM only.', rate_version: 'synthetic:v1' },
  };
  try {
    const out = text();
    expect(out).toContain('$10.80 · 188 priced requests · 2,376 unpriced requests · 5 failed requests');
    expect(out).not.toContain('$10.8045');
    const buckets = [...out.matchAll(/([\d,]+) (?:priced|unpriced|failed) requests/g)].map((m) =>
      Number(m[1]!.replace(/,/g, '')),
    );
    expect(buckets.reduce((a, b) => a + b, 0)).toBe(2569);
    expect(out).toContain('2,569');
  } finally {
    overviewOverride = null;
  }
});
test('usd2 rounds to cents and keeps a sub-cent estimate visible', () => {
  expect(usd2(10.8045)).toBe('$10.80');
  expect(usd2(0)).toBe('$0.00');
  expect(usd2(0.004)).toBe('<$0.01');
  expect(usd2(1234.5)).toBe('$1,234.50');
});
