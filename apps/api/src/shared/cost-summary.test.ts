import { describe, expect, test } from 'bun:test';
import { assembleCostSummary } from './cost-summary';

const window = { from: new Date('2026-07-01Z'), to: new Date('2026-07-02Z') };
const model = (provider: string | null, name: string | null, cost = '0.1') => ({
  setId: 'model', provider, model: name, day: null, projectId: null,
  llmCost: cost, llmKortixCost: cost, llmProviderCost: '90', requestCount: '2', sessionCount: '3',
});

describe('pure cost summary assembly', () => {
  test('empty inputs produce zero totals and a gap-filled day', () => {
    const summary = assembleCostSummary(window, [], [], [], [], [], []);
    expect(summary.totals.total_cost).toBe(0);
    expect(summary.previous.total_cost).toBe(0);
    expect(summary.models).toEqual([]);
    expect(summary.series).toEqual([{ day: '2026-07-01', llm_cost: 0, compute_cost: 0, storage_cost: 0, total_cost: 0 }]);
  });

  test('BYOK is separate, unassigned compute counts money, projects union, and sessions approximate', () => {
    const summary = assembleCostSummary(window, [
      { ...model('', ''), setId: 'totals' },
      { ...model('provider', 'model'), setId: 'project', projectId: 'llm-project' },
    ], [{ cost: '0.1' }], [
      { setId: 'totals', day: null, projectId: null, computeCost: '0.2', computeSeconds: '12', sessionCount: '4' },
      { setId: 'project', day: null, projectId: null, computeCost: '0.2', computeSeconds: 12, sessionCount: 4 },
    ], [{ cost: '0.2' }], [{ day: '2026-07-01', cost: '0.3', gibHours: '8', projectIds: ['llm-project', 'storage-project'] }], [{ cost: '0.3' }]);
    expect(summary.totals).toMatchObject({ llm_cost: 0.1, llm_provider_cost: 90, compute_cost: 0.2, storage_cost: 0.3, total_cost: 0.6, session_count: 4, project_count: 2, storage_gib_hours: 8 });
    expect(summary.previous.total_cost).toBe(0.6);
  });

  test('storage-only and malformed numeric rows preserve canonical conversion', () => {
    const summary = assembleCostSummary(window, [], [], [], [], [
      { day: '2026-07-01', cost: '0.123456789012', gibHours: 'invalid', projectIds: null },
    ], [{ cost: null }]);
    expect(summary.totals).toMatchObject({ storage_cost: 0.123456789, total_cost: 0.123456789, storage_gib_hours: 0, project_count: 0 });
  });

  test('top ten ties descend by provider then model, including empty strings', () => {
    const summary = assembleCostSummary(window, [model('', ''), ...Array.from({ length: 12 }, (_, i) => model('p', String(i).padStart(2, '0')))], [], [], [], [], []);
    expect(summary.models.map((row) => row.model)).toEqual(['11', '10', '09', '08', '07', '06', '05', '04', '03', '02']);
    expect(assembleCostSummary(window, [model('', '')], [], [], [], [], []).models[0]?.provider).toBe('');
  });

  test('null model grouping columns are rejected', () => {
    expect(() => assembleCostSummary(window, [model(null, 'm')], [], [], [], [], [])).toThrow('without provider/model');
    expect(() => assembleCostSummary(window, [model('p', null)], [], [], [], [], []) ).toThrow('without provider/model');
  });
});
