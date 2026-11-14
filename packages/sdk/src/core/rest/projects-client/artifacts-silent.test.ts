import { afterEach, expect, test } from 'bun:test';
import { configureKortix } from '../../http/config';
import { getArtifact } from './artifacts';

afterEach(() => configureKortix({ backendUrl: '', getToken: async () => null }));

test('artifact background reads can suppress permission errors without changing the request URL', async () => {
  const errors: unknown[] = [];
  const urls: string[] = [];
  configureKortix({
    backendUrl: 'https://api.example.test/v1', getToken: async () => 'synthetic-token',
    onError: (e) => errors.push(e),
    fetch: async (url) => { urls.push(String(url)); return Response.json({ error: 'Forbidden' }, { status: 403 }); },
  });
  await expect(getArtifact('project', 'artifact', { showErrors: false })).rejects.toMatchObject({ status: 403 });
  expect(errors).toHaveLength(0);
  expect(urls).toEqual(['https://api.example.test/v1/workspaces/project/artifacts/artifact']);
  await expect(getArtifact('project', 'artifact')).rejects.toMatchObject({ status: 403 });
  expect(errors).toHaveLength(1);
});
