import { describe, expect, test } from 'bun:test';
import { platinumSnapshotQuotaIo, reconcileSnapshotQuota } from './quota-gc';
import type { PlatinumClient } from './providers/platinum-templates';

// 2026-11-19: the prod Platinum org held 500/500 templates and every build in
// it failed with `org_template_quota_exceeded`, because the quota GC ran for
// Daytona only. These cases drive one Platinum pass through a fake control
// plane shaped like that org.

const NOW = Date.parse('2026-11-19T00:00:00Z');
const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW - days * DAY).toISOString();

interface FakeTemplate {
  id: string;
  name: string;
  state: string;
  createdAt: string;
  lastUsedAt: string | null;
  global?: boolean;
  inUse?: boolean;
}

function fakePlatinum(templates: FakeTemplate[]) {
  const deleted: string[] = [];
  const detailReads: string[] = [];
  const client: PlatinumClient = {
    isConfigured: () => true,
    json: async <T,>(path: string, init: RequestInit = {}): Promise<T> => {
      const list = /^\/v1\/templates\?limit=(\d+)&offset=(\d+)/.exec(path);
      if (list) {
        const [limit, offset] = [Number(list[1]), Number(list[2])];
        // The list route omits lastUsedAt, like Platinum's.
        return templates
          .slice(offset, offset + limit)
          .map(({ lastUsedAt: _lastUsedAt, inUse: _inUse, ...row }) => row) as T;
      }
      const one = /^\/v1\/templates\/([^/?]+)$/.exec(path);
      const template = one ? templates.find((t) => t.id === decodeURIComponent(one[1])) : undefined;
      if (!template) throw new Error(`platinum GET ${path} -> 404 {"error":"not found"}`);
      if (init.method === 'DELETE') {
        if (template.inUse) {
          throw new Error(`platinum DELETE ${path} -> 409 {"code":"template_in_use","in_use":1}`);
        }
        deleted.push(template.name);
        return {} as T;
      }
      detailReads.push(template.name);
      return { lastUsedAt: template.lastUsedAt } as T;
    },
  };
  return { client, deleted, detailReads };
}

function tpl(name: string, opts: Partial<FakeTemplate> = {}): FakeTemplate {
  return {
    id: `tpl_${name}`,
    name,
    state: 'ready',
    createdAt: ago(30),
    lastUsedAt: ago(1),
    ...opts,
  };
}

/** Referenced App images that fill the org up to `total` templates. */
function filler(count: number): FakeTemplate[] {
  return Array.from({ length: count }, (_unused, i) => tpl(`kortix-appimg-prod-${i}`));
}

async function pass(templates: FakeTemplate[], referenced: string[]) {
  const fake = fakePlatinum(templates);
  const io = {
    ...platinumSnapshotQuotaIo(fake.client, () => NOW),
    loadReferencedSnapshotNames: async () => new Set(referenced),
  };
  const result = await reconcileSnapshotQuota({ now: NOW, budgetState: { lastReportedAtMs: null } }, io);
  return { result, ...fake };
}

describe('the Platinum quota GC pass', () => {
  test('a full org reclaims failed builds, stale defaults and idle superseded images, and keeps live ones', async () => {
    const defaults = Array.from({ length: 14 }, (_unused, i) =>
      tpl(`kortix-default-${String(i).padStart(2, '0')}`, { createdAt: ago(i + 1), lastUsedAt: ago(i + 1) }),
    );
    const named = [
      tpl('kortix-tpl-failed', { state: 'failed' }),
      tpl('kortix-tpl-current', { lastUsedAt: ago(40) }),
      tpl('kortix-tpl-superseded', { lastUsedAt: ago(20) }),
      tpl('kortix-tpl-old-but-used', { createdAt: ago(90), lastUsedAt: ago(2) }),
      tpl('kortix-tpl-never-used', { lastUsedAt: null }),
      tpl('kortix-tpl-recent', { createdAt: ago(3), lastUsedAt: null }),
      tpl('kortix-tpl-running', { lastUsedAt: ago(20), inUse: true }),
      tpl('pt-base', { global: true }),
      tpl('someone-elses-image', { lastUsedAt: ago(200) }),
      ...defaults,
    ];
    const appImages = filler(500 - (named.length - 1));
    const { result, deleted, detailReads } = await pass(
      [...named, ...appImages],
      ['kortix-tpl-current', ...appImages.map((t) => t.name)],
    );

    expect(result.observationStatus).toBe('complete');
    // Global templates are Platinum's; the org cap does not count them.
    expect(result.orgTotal).toBe(500);
    expect(deleted.sort()).toEqual([
      'kortix-default-12',
      'kortix-default-13',
      'kortix-tpl-failed',
      'kortix-tpl-never-used',
      'kortix-tpl-superseded',
    ]);
    // In use on Platinum: chosen, refused with 409, not counted as deleted.
    expect(result.deleted).toBe(5);
    expect(result.eligible).toBe(6);
    // Only images older than the idle floor need their last use read.
    expect(detailReads).not.toContain('kortix-tpl-recent');
    expect(detailReads).not.toContain('kortix-default-00');
    expect(detailReads).toContain('kortix-tpl-old-but-used');
  });

  test('an org below 80% of its cap deletes nothing and reads no template detail', async () => {
    const templates = [tpl('kortix-tpl-failed', { state: 'failed' }), ...filler(398)];
    const { result, deleted, detailReads } = await pass(templates, []);

    expect(result.orgTotal).toBe(399);
    expect(deleted).toEqual([]);
    expect(detailReads).toEqual([]);
  });

  test('a template whose detail read fails is kept', async () => {
    const templates = [tpl('kortix-tpl-unknown', { id: 'tpl_unknown', lastUsedAt: ago(30) }), ...filler(450)];
    const fake = fakePlatinum(templates);
    const client: PlatinumClient = {
      isConfigured: () => true,
      json: async <T,>(path: string, init?: RequestInit): Promise<T> => {
        if (path === '/v1/templates/tpl_unknown' && !init?.method) {
          throw new Error('platinum GET /v1/templates/tpl_unknown -> 503 {"error":"unavailable"}');
        }
        return fake.client.json<T>(path, init);
      },
    };
    const io = {
      ...platinumSnapshotQuotaIo(client, () => NOW),
      loadReferencedSnapshotNames: async () => new Set<string>(),
    };
    await reconcileSnapshotQuota({ now: NOW, budgetState: { lastReportedAtMs: null } }, io);

    expect(fake.deleted).not.toContain('kortix-tpl-unknown');
  });
});
