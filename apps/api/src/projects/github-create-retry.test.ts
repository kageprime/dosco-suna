import { afterEach, expect, spyOn, test } from 'bun:test';
import { createRepo } from './github-repositories';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const auth = { token: 'synthetic', source: 'pat', owner: 'managed-org', ownerType: 'Organization' } satisfies Parameters<typeof createRepo>[0]['auth'];
const repo = {
  id: 1, name: 'sample', full_name: 'managed-org/sample', private: true, size: 0,
  created_at: new Date(Date.now() + 1000).toISOString(),
  html_url: 'https://github.com/managed-org/sample',
  clone_url: 'https://github.com/managed-org/sample.git',
  ssh_url: 'git@github.com:managed-org/sample.git', default_branch: 'main', description: null,
};
function responses(answers: Array<[number, object]>) {
  const calls: string[] = [];
  globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${String(input)}`);
    const answer = answers.shift();
    if (!answer) throw new Error('Unexpected request');
    return Response.json(answer[1], { status: answer[0] });
  }, { preconnect: originalFetch.preconnect });
  return calls;
}
const input = { name: 'sample', autoInit: false, auth, retryTransientCreation: true };
test('managed creation recovers 502 then 201 only after an absent read', async () => {
  const sleep = spyOn(Bun, 'sleep').mockResolvedValue(undefined);
  try {
    const calls = responses([[502, { message: 'Server Error' }], [404, {}], [201, repo]]);
    expect(await createRepo(input)).toEqual(repo);
    expect(calls.map(call => call.split(' ')[0])).toEqual(['POST', 'GET', 'POST']);
  } finally { sleep.mockRestore(); }
});
test('ambiguous success is read back without replaying POST', async () => {
  const calls = responses([[502, {}], [200, repo]]);
  expect(await createRepo(input)).toEqual(repo);
  expect(calls).toHaveLength(2);
});
test('502 then 422 recovers the newly visible empty repo', async () => {
  const sleep = spyOn(Bun, 'sleep').mockResolvedValue(undefined);
  try {
    responses([[502, {}], [404, {}], [422, { message: 'name already exists on this account' }], [200, repo]]);
    expect(await createRepo(input)).toEqual(repo);
  } finally { sleep.mockRestore(); }
});
const structuredCollision = {
  message: 'Repository creation failed.',
  errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }],
};
test('structured 422 collision after an ambiguous POST reconciles the exact coordinate', async () => {
  const sleep = spyOn(Bun, 'sleep').mockResolvedValue(undefined);
  try {
    const calls = responses([[502, {}], [404, {}], [422, structuredCollision], [200, repo]]);
    expect(await createRepo(input)).toEqual(repo);
    expect(calls).toEqual([
      'POST https://api.github.com/orgs/managed-org/repos',
      'GET https://api.github.com/repos/managed-org/sample',
      'POST https://api.github.com/orgs/managed-org/repos',
      'GET https://api.github.com/repos/managed-org/sample',
    ]);
  } finally { sleep.mockRestore(); }
});
test('initial structured 422 collision does not recover or retry', async () => {
  const calls = responses([[422, structuredCollision]]);
  await expect(createRepo(input)).rejects.toThrow('(422): Repository creation failed.');
  expect(calls).toHaveLength(1);
});
test('unrelated structured 422 after a transient failure does not reconcile again', async () => {
  const sleep = spyOn(Bun, 'sleep').mockResolvedValue(undefined);
  try {
    const calls = responses([[502, {}], [404, {}], [422, {
      message: 'Repository creation failed.',
      errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name is invalid' }],
    }]]);
    await expect(createRepo(input)).rejects.toThrow('(422): Repository creation failed.');
    expect(calls).toHaveLength(3);
  } finally { sleep.mockRestore(); }
});
for (const status of [401, 403, 404, 422]) test(`does not retry initial ${status}`, async () => {
  const calls = responses([[status, { message: 'refused' }]]);
  await expect(createRepo(input)).rejects.toThrow(`(${status}): refused`);
  expect(calls).toHaveLength(1);
});
test('persistent 503 is bounded and preserves the upstream error', async () => {
  const sleep = spyOn(Bun, 'sleep').mockResolvedValue(undefined);
  try {
    const calls = responses(Array.from({ length: 3 }, () => [[503, { message: 'Server Error' }], [404, {}]] satisfies Array<[number, object]>).flat());
    await expect(createRepo(input)).rejects.toThrow('GitHub /orgs/managed-org/repos failed (503): Server Error');
    expect(calls).toHaveLength(6);
  } finally { sleep.mockRestore(); }
});
for (const changed of [{ full_name: 'other/sample' }, { size: 1 }, { private: false }, { created_at: '2020-01-01T00:00:00Z' }]) test(`refuses unrelated recovery ${JSON.stringify(changed)}`, async () => {
  const calls = responses([[504, {}], [200, { ...repo, ...changed }]]);
  await expect(createRepo(input)).rejects.toThrow('(504)');
  expect(calls).toHaveLength(2);
});
test('ordinary GitHub callers retain single-attempt behavior', async () => {
  const calls = responses([[502, {}]]);
  await expect(createRepo({ name: 'sample', auth })).rejects.toThrow('(502)');
  expect(calls).toHaveLength(1);
});

test('a failed reconciliation never replays the write', async () => {
  const calls = responses([[502, {}], [503, {}]]);
  await expect(createRepo(input)).rejects.toThrow('(502)');
  expect(calls).toHaveLength(2);
});
test('personal PAT owner uses user create and the exact owner read', async () => {
  const calls = responses([[502, {}], [200, repo]]);
  expect(await createRepo({ ...input, auth: { ...auth, ownerType: 'User' } })).toEqual(repo);
  expect(calls).toEqual(['POST https://api.github.com/user/repos', 'GET https://api.github.com/repos/managed-org/sample']);
});
test('auto-initialized repositories never opt into recovery', async () => {
  const calls = responses([[502, {}]]);
  await expect(createRepo({ ...input, autoInit: true })).rejects.toThrow('(502)');
  expect(calls).toHaveLength(1);
});

test('managed backend enables recovery and maps the recovered repository', async () => {
  const { __setStoredGitBackendForTests } = await import('../platform/services/managed-git-backend');
  const { githubBackend } = await import('./git-backends/github');
  __setStoredGitBackendForTests({ kind: 'pat', owner: 'managed-org', token: 'synthetic' });
  try {
    const calls = responses([[200, { type: 'Organization' }], [502, {}], [200, repo]]);
    const result = await githubBackend.createRepo({ accountId: 'synthetic-account', projectId: 'synthetic-project', slug: 'sample', defaultBranch: 'dev', isPrivate: true });
    expect(result).toMatchObject({ externalRepoId: '1', repoOwner: 'managed-org', repoName: 'sample', upstreamUrl: repo.clone_url, defaultBranch: 'main' });
    expect(calls).toHaveLength(3);
  } finally { __setStoredGitBackendForTests({}); }
});
