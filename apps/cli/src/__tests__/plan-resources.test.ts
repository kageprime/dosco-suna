import { expect, test } from 'bun:test';
import { proposeResources } from '../onboarding/repo-scan.ts';

// A trackstage worker crashed with ~1.5 GB free (Vite, Convex, workerd and
// Playwright in 4 GB). The plan sizes the sandbox from what runs in it.
test('a plain repository gets the base size', () => {
  expect(proposeResources({ browserTests: false, containerRuntime: false, services: 0, workerd: false, monorepo: false })).toMatchObject({ cpu: 2, memory: 4, disk: 20 });
});

test('browser tests, a local service and a worker runtime add memory and CPU, each with a reason', () => {
  const r = proposeResources({ browserTests: true, containerRuntime: false, services: 1, workerd: true, monorepo: false });
  expect(r).toMatchObject({ cpu: 4, memory: 8, disk: 25 });
  expect(r.reasons).toHaveLength(4);
});

test('memory is capped at 16 GB', () => {
  expect(proposeResources({ browserTests: true, containerRuntime: true, services: 9, workerd: true, monorepo: true }).memory).toBe(16);
});
