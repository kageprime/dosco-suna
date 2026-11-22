import { describe, expect, test } from 'bun:test';
import { createGoogleClient } from './client';
import { SHEETS_TOOLS } from './sheets';

function fixture(grid: unknown[][]) {
  const calls: Array<{ path: string; method: string; body: unknown }> = [];
  const google = createGoogleClient({ token: 'synthetic', fetchImpl: async (input, init) => {
    const url = new URL(input);
    calls.push({ path: decodeURIComponent(url.pathname), method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : null });
    return Response.json(url.pathname.includes('/values/') ? { values: grid } : { sheets: [{ properties: { sheetId: 7, title: 'Sales', index: 0 } }] });
  } });
  return { calls, run: async (sql: string, extra: Record<string, unknown> = {}) => {
    const tool = SHEETS_TOOLS.find((tool) => tool.name === 'execute_sql');
    if (!tool) throw new Error('execute_sql missing');
    return tool.run({ spreadsheet_id: 'synthetic-sheet', sql, ...extra }, { google });
  } };
}

describe('Sheets SQL tool boundary', () => {
  test('quoted columns, null filtering, descending ordering and distinct preserve projection', async () => {
    const f = fixture([['Full Name', 'Amount'], ['A', 4], ['B', null], ['A', 4], ['C', 9]]);
    expect(await f.run('SELECT DISTINCT "Full Name", Amount FROM Sales WHERE Amount IS NOT NULL ORDER BY Amount DESC')).toMatchObject({
      operation: 'SELECT', data: [{ 'Full Name': 'C', Amount: 9 }, { 'Full Name': 'A', Amount: 4 }], affected_rows: 2,
      table_schema: [{ name: 'Full Name', type: 'TEXT' }, { name: 'Amount', type: 'INTEGER' }],
    });
    expect(f.calls.map((call) => call.method)).toEqual(['GET', 'GET']);
  });

  test('grouped aggregates and empty grids preserve output', async () => {
    expect(await fixture([['Region', 'Amount'], ['EU', 4], ['EU', 6], ['US', 3]]).run('SELECT Region, SUM(Amount) AS total FROM Sales GROUP BY Region ORDER BY total DESC')).toMatchObject({ data: [{ Region: 'EU', total: 10 }, { Region: 'US', total: 3 }] });
    expect(await fixture([]).run('SELECT * FROM Sales')).toMatchObject({ data: [], affected_rows: 0, table_schema: [] });
  });

  for (const [sql, suffix, body] of [
    ["INSERT INTO Sales (Name, Amount) VALUES ('B', 8)", "/values/'Sales'!A1:B:append", { values: [['B', 8]] }],
    ["UPDATE Sales SET Amount = 8 WHERE Name = 'A'", '/values:batchUpdate', { valueInputOption: 'USER_ENTERED', data: [{ range: "'Sales'!B2", values: [[8]] }] }],
    ["DELETE FROM Sales WHERE Name = 'A'", '/values:batchClear', { ranges: ["'Sales'!A2:B2"] }],
  ] as const) {
    test(`${sql}: dry run reads only; write sends exact payload after reads`, async () => {
      const dry = fixture([['Name', 'Amount'], ['A', 4]]);
      expect(await dry.run(sql, { dry_run: true })).toMatchObject({ affected_rows: 1 });
      expect(dry.calls.map((call) => call.method)).toEqual(['GET', 'GET']);
      const real = fixture([['Name', 'Amount'], ['A', 4]]);
      expect(await real.run(sql)).toMatchObject({ affected_rows: 1 });
      expect(real.calls.map((call) => call.method)).toEqual(['GET', 'GET', 'POST']);
      expect(real.calls[2]).toEqual({ path: `/v4/spreadsheets/synthetic-sheet${suffix}`, method: 'POST', body });
    });
  }
});
