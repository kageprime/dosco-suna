/**
 * Characterization (KRTX-4928): the `sandbox_provider_transition` marker that
 * activation (`writeActivationPin`) and the pin set/clear (`setPinWithGenerationBump`)
 * write into project metadata. Both pass before and after the marker builder
 * moved into provider-transition-routing.ts.
 */
import { describe, expect, mock, test } from 'bun:test';
import { createDb, type Database } from '@kortix/db';
import * as realAudit from './provider-transition-audit';

// The after-commit audit would hit the real database; spy it away.
mock.module('./provider-transition-audit', () => ({ ...realAudit, auditProviderTransition: async () => {} }));
const { activateWithCas, setPinWithGenerationBump } = await import('./provider-transition-activate');

const NOW = new Date('2026-11-14T00:00:00.000Z');

/** The JSON object params an `sql` template carries, parsed. */
function jsonParams(expr: unknown): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const walk = (chunk: unknown): void => {
    if (Array.isArray(chunk)) return void chunk.forEach(walk);
    if (typeof chunk === 'string') {
      if (chunk.startsWith('{')) out.push(JSON.parse(chunk));
      return;
    }
    if (chunk && typeof chunk === 'object' && 'queryChunks' in chunk) (chunk as { queryChunks: unknown[] }).queryChunks.forEach(walk);
  };
  walk(expr);
  return out;
}

function markerOf(set: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  return jsonParams(set?.metadata)
    .map((patch) => patch.sandbox_provider_transition)
    .find((marker): marker is Record<string, unknown> => marker !== undefined) as Record<string, unknown> | undefined;
}

function fakeDatabase(writes: Array<Record<string, unknown>>): Database {
  const tx = {
    select: () => ({
      from: () => ({
        where: () => ({
          for: () => ({ limit: async () => [{ metadata: {}, generation: 3, status: 'active' }] }),
          limit: async () => [],
        }),
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => {
        writes.push(values);
        return { where: () => Object.assign(Promise.resolve([]), { returning: async () => [{ projectId: 'p1' }] }) };
      },
    }),
  };
  // createDb is lazy (no connection until a query), so a real Database carries the faked transaction.
  return Object.assign(createDb('postgres://fake@localhost:1/fake'), {
    transaction: (cb: (tx: unknown) => unknown) => cb(tx),
  });
}

describe('transition marker written into project metadata', () => {
  test('activation records status, target, generation, image name, external id and time', async () => {
    const writes: Array<Record<string, unknown>> = [];
    await activateWithCas(fakeDatabase(writes), {
      projectId: 'p1',
      transitionId: 't1',
      targetProvider: 'platinum',
      generation: 3,
      snapshotName: 'kortix-ppwarm-p1',
      externalTemplateId: 'tpl-1',
      now: NOW,
    });
    expect(markerOf(writes[0])).toEqual({
      status: 'activated',
      target_provider: 'platinum',
      generation: 3,
      snapshot_name: 'kortix-ppwarm-p1',
      external_template_id: 'tpl-1',
      activated_at: NOW.toISOString(),
    });
  });

  test('setting a pin records an activated marker without image keys, at the bumped generation', async () => {
    const writes: Array<Record<string, unknown>> = [];
    await setPinWithGenerationBump(fakeDatabase(writes), { projectId: 'p1', pin: 'daytona', now: NOW });
    expect(markerOf(writes[0])).toEqual({
      status: 'activated',
      target_provider: 'daytona',
      generation: 4,
      activated_at: NOW.toISOString(),
    });
  });

  test('clearing the pin records a cleared marker with a null target', async () => {
    const writes: Array<Record<string, unknown>> = [];
    await setPinWithGenerationBump(fakeDatabase(writes), { projectId: 'p1', pin: null, now: NOW });
    expect(markerOf(writes[0])).toEqual({
      status: 'cleared',
      target_provider: null,
      generation: 4,
      activated_at: NOW.toISOString(),
    });
  });
});
