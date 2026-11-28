import { afterEach, describe, expect, it, vi } from 'vitest';
import { allFlows } from '../src/core/flow';
import '../src/flows/drive-search.flow';

const pg = vi.hoisted(() => ({ options: vi.fn(), connect: vi.fn(async () => {}) }));
vi.mock('pg', () => ({
  Client: class {
    constructor(options: unknown) { pg.options(options); }
    connect = pg.connect;
  },
}));

afterEach(() => vi.clearAllMocks());

describe('DRIVE-5 database connection boundary', () => {
  it.each([
    ['postgres://postgres@localhost:54322/test', false],
    ['postgres://postgres@127.0.0.1:54322/test', false],
    ['postgres://postgres@database.example.test:5432/test', { rejectUnauthorized: false }],
  ])('connects with the existing TLS policy for %s', async (databaseUrl, ssl) => {
    const drive = allFlows().find((entry) => entry.id === 'DRIVE-5');
    if (!drive) throw new Error('DRIVE-5 is not registered');
    const fixtureStop = new Error('stop after connection');
    await expect(drive.fn({
      env: { databaseUrl },
      fixtures: { team: async () => { throw fixtureStop; } },
    })).rejects.toBe(fixtureStop);
    expect(pg.options).toHaveBeenCalledExactlyOnceWith({ connectionString: databaseUrl, ssl });
    expect(pg.connect).toHaveBeenCalledOnce();
  });
});
