import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { CostSummaryTiles, formatPeriodDelta, formatShare } from './cost-summary-tiles';

describe('formatPeriodDelta', () => {
  test('reports a rise against the prior window', () => {
    expect(formatPeriodDelta(46.42, 37.74)).toEqual({ label: '+23%', direction: 'up' });
  });

  test('reports a fall', () => {
    expect(formatPeriodDelta(50, 100)).toEqual({ label: '-50%', direction: 'down' });
  });

  test('returns null when the prior window had no spend', () => {
    expect(formatPeriodDelta(10, 0)).toBeNull();
  });

  test('reports flat when unchanged', () => {
    expect(formatPeriodDelta(10, 10)).toEqual({ label: '0%', direction: 'flat' });
  });

  test('returns null when the prior window was negative (corrupt data guard)', () => {
    expect(formatPeriodDelta(10, -5)).toBeNull();
  });
});

const baseSummary = {
  totals: {
    llm_cost: 12.4,
    llm_kortix_cost: 0,
    llm_provider_cost: 12.4,
    compute_cost: 34.02,
    storage_cost: 0.82,
    total_cost: 46.42,
    request_count: 100,
    compute_seconds: 3600,
    storage_gib_hours: 10000,
    session_count: 41,
    project_count: 3,
  },
  previous: { total_cost: 37.74 },
  // One point per day, as /usage/cost-summary always returns. An empty series
  // was never a shape the route produces, and it silently skipped the
  // sparklines these tiles now render.
  series: [
    { day: '2026-07-01', llm_cost: 1, compute_cost: 6, storage_cost: 0.2, total_cost: 7 },
    { day: '2026-07-02', llm_cost: 2, compute_cost: 7, storage_cost: 0.2, total_cost: 9 },
    { day: '2026-07-03', llm_cost: 4, compute_cost: 9, storage_cost: 0.21, total_cost: 13 },
    { day: '2026-07-04', llm_cost: 5, compute_cost: 12, storage_cost: 0.21, total_cost: 17 },
  ],
  models: [],
};

describe('CostSummaryTiles', () => {
  test('renders the total and the delta against the prior window', () => {
    const html = renderToStaticMarkup(
      <CostSummaryTiles isLoading={false} extraTiles={[]} summary={baseSummary} />,
    );
    expect(html).toContain('4,642');
    expect(html).toContain('+23%');
  });

  test('shows spend in credits, never in dollars, and each part as a share of the total', () => {
    const html = renderToStaticMarkup(
      <CostSummaryTiles isLoading={false} extraTiles={[]} summary={baseSummary} />,
    );
    expect(html).toContain('>credits</span>');
    expect(html).not.toContain('$');
    // 34.02 / 46.42 compute, 12.4 / 46.42 LLM, 0.82 / 46.42 storage.
    expect(html).toContain('>73%<');
    expect(html).toContain('>27%<');
    expect(html).toContain('>2%<');
  });

  test('marks each part with the kortix accent its chart bars use', () => {
    const html = renderToStaticMarkup(
      <CostSummaryTiles isLoading={false} extraTiles={[]} summary={baseSummary} />,
    );
    expect(html).toContain('background-color:var(--kortix-blue)');
    expect(html).toContain('background-color:var(--kortix-orange)');
    expect(html).toContain('background-color:var(--kortix-purple)');
  });

  test('renders LLM, compute and storage tiles without a delta of their own', () => {
    const html = renderToStaticMarkup(
      <CostSummaryTiles isLoading={false} extraTiles={[]} summary={baseSummary} />,
    );
    expect(html).toContain('1,240');
    expect(html).toContain('3,402');
    expect(html).toContain('>Storage<');
    expect(html).toContain('>82<');
    // Only the total tile shows a period delta. Counting "%" characters would
    // now double-count — the accessible name repeats the figure — so count the
    // delta paragraphs, which is what the assertion always meant.
    expect(html.match(/versus the prior period/g)?.length ?? 0).toBe(1);
  });

  test('never renders the delta as a coloured badge or with green/red text', () => {
    const html = renderToStaticMarkup(
      <CostSummaryTiles isLoading={false} extraTiles={[]} summary={baseSummary} />,
    );
    expect(html).not.toContain('data-slot="badge"');
    const delta = html.match(/<span class="([^"]*)" aria-label="\+23% versus the prior period">\+23%<\/span>/);
    expect(delta).not.toBeNull();
    expect(delta![1]).not.toMatch(/text-kortix-(green|red)/);
  });

  test('suppresses the delta entirely when the prior window had no spend', () => {
    const html = renderToStaticMarkup(
      <CostSummaryTiles
        isLoading={false}
        extraTiles={[]}
        summary={{ ...baseSummary, previous: { total_cost: 0 } }}
      />,
    );
    expect(html).toContain('4,642');
    expect(html).not.toContain('versus the prior period');
  });

  test('renders extra caller-supplied tiles alongside the fixed three', () => {
    const html = renderToStaticMarkup(
      <CostSummaryTiles
        isLoading={false}
        extraTiles={[
          { label: 'Sessions', value: '41' },
          { label: 'Projects', value: '3' },
        ]}
        summary={baseSummary}
      />,
    );
    expect(html).toContain('Sessions');
    expect(html).toContain('41');
    expect(html).toContain('Projects');
  });

  test('shows a skeleton instead of figures while loading, never a spinner icon', () => {
    const html = renderToStaticMarkup(
      <CostSummaryTiles isLoading={true} extraTiles={[]} summary={undefined} />,
    );
    expect(html).not.toContain('4,642');
    expect(html).not.toContain('animate-spin');
    expect(html).toContain('animate-pulse');
  });

  test('renders a loading skeleton when no summary is available yet, even if isLoading is stale-false', () => {
    const html = renderToStaticMarkup(
      <CostSummaryTiles isLoading={false} extraTiles={[]} summary={undefined} />,
    );
    expect(html).toContain('animate-pulse');
  });
});

describe('formatShare', () => {
  test('rounds to a whole percent', () => {
    expect(formatShare(34.02, 46.42)).toBe('73%');
  });

  test('a real but tiny part reads <1%, not 0%', () => {
    expect(formatShare(0.0055, 25.48)).toBe('<1%');
  });

  test('a zero part of a real total is 0%; any part of a zero total has no share', () => {
    expect(formatShare(0, 10)).toBe('0%');
    expect(formatShare(0, 0)).toBe('');
  });
});
