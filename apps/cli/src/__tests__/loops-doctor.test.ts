import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectLoopChecks, isQuickTunnel } from '../onboarding/loops-doctor.ts';
import { githubEventsOfFilter } from '../onboarding/manifest-needs.ts';

// The tunnel line exists only for a quick tunnel: its URL changes on every
// restart, and then every webhook and sandbox callback misses the API.
let dir = '';
afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

test('a quick tunnel is only a *.trycloudflare.com API base', () => {
  expect(isQuickTunnel('https://synthetic-words.trycloudflare.com')).toBe(true);
  expect(isQuickTunnel('https://synthetic-words.trycloudflare.com/v1')).toBe(true);
  expect(isQuickTunnel('https://api.kortix.com')).toBe(false);
  expect(isQuickTunnel('http://localhost:8008/v1')).toBe(false);
  expect(isQuickTunnel(null)).toBe(false);
});

test('an unreachable tunnel is a red line that probes /v1/health; a reachable one is green', async () => {
  dir = mkdtempSync(join(tmpdir(), 'kortix-loops-doctor-'));
  writeFileSync(join(dir, 'kortix.yaml'), 'default_agent: mykortix\nbuiltin_agents:\n  my_kortix: true\n');
  const probed: string[] = [];
  const base = { root: dir, manifestFile: join(dir, 'kortix.yaml'), needs: null, client: null, projectId: null, repo: null, apiBase: 'https://synthetic-words.trycloudflare.com' };
  const down = await collectLoopChecks({ ...base, fetchHealth: async (url) => (probed.push(url), 530) });
  expect(probed).toEqual(['https://synthetic-words.trycloudflare.com/v1/health']);
  expect(down.find((c) => c.name === 'public URL')).toMatchObject({ state: 'fail' });
  const up = await collectLoopChecks({ ...base, fetchHealth: async () => 200 });
  expect(up.find((c) => c.name === 'public URL')).toMatchObject({ state: 'ok' });
  const cloud = await collectLoopChecks({ ...base, apiBase: 'https://api.kortix.com', fetchHealth: async () => 0 });
  expect(cloud.find((c) => c.name === 'public URL')).toBeUndefined();
});

test('GitHub events come from headers.github_event: one event, { in: [...] }, or nested headers', () => {
  expect(githubEventsOfFilter({ 'headers.github_event': 'issues' })).toEqual(['issues']);
  expect(githubEventsOfFilter({ 'headers.github_event': { in: ['pull_request_review', 'issue_comment'] } })).toEqual(['pull_request_review', 'issue_comment']);
  expect(githubEventsOfFilter({ headers: { github_event: 'push' } })).toEqual(['push']);
  expect(githubEventsOfFilter({ 'body.action': 'labeled' })).toEqual([]);
  expect(githubEventsOfFilter(undefined)).toEqual([]);
});
