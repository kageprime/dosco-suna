import { afterEach, expect, test } from 'bun:test';
import { configureKortix } from '../../http/config';
import { searchWorkspaceFiles } from './files';

afterEach(() => configureKortix({ backendUrl: '', getToken: async () => null }));

test('a background repo search can suppress a permission error without changing the request URL', async () => {
  const errors: unknown[] = [];
  const urls: string[] = [];
  configureKortix({
    backendUrl: 'https://api.example.test/v1', getToken: async () => 'synthetic-token',
    onError: (e) => errors.push(e),
    fetch: async (url) => { urls.push(String(url)); return Response.json({ error: 'Forbidden' }, { status: 403 }); },
  });
  await expect(searchWorkspaceFiles('project', 'readme', { limit: 20, showErrors: false })).rejects.toMatchObject({ status: 403 });
  expect(errors).toHaveLength(0);
  expect(urls).toEqual(['https://api.example.test/v1/workspaces/project/files/search?q=readme&limit=20']);
  // The default still reports, as before.
  await expect(searchWorkspaceFiles('project', 'readme')).rejects.toMatchObject({ status: 403 });
  expect(errors).toHaveLength(1);
});
