import { afterEach, expect, mock, test } from "bun:test";
import { configureKortix } from "../../http/config";
import * as api from "./artifacts";
const original = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = original;
});
test("folder CRUD preserves icon payloads and root filtering is explicit", async () => {
  const calls: { url: string; method: string; body: unknown }[] = [];
  configureKortix({
    backendUrl: "http://test.local",
    getToken: async () => "tok",
  });
  globalThis.fetch = mock(async (url: unknown, opts: RequestInit = {}) => {
    calls.push({
      url: String(url),
      method: opts.method ?? "GET",
      body: opts.body ? JSON.parse(String(opts.body)) : undefined,
    });
    return Response.json({
      folders: [],
      folder_id: "f1",
      deleted: true,
      artifacts: [],
    });
  }) as unknown as typeof fetch;
  await api.listArtifactFolders("p1");
  await api.createArtifactFolder("p1", {
    name: "Launch",
    icon: "🚀",
    icon_glyph: null,
  });
  await api.updateArtifactFolder("p1", "f1", {
    name: "Archive",
    icon: null,
    icon_glyph: { name: "folder", color: "grey" },
  });
  await api.deleteArtifactFolder("p1", "f1");
  await api.listArtifacts("p1", { folder_id: "root" });
  await api.updateArtifact("p1", "a1", { folder_id: null });
  expect(calls.map((c) => [c.method, c.url])).toEqual([
    ["GET", "http://test.local/workspaces/p1/artifacts/folders"],
    ["POST", "http://test.local/workspaces/p1/artifacts/folders"],
    ["PATCH", "http://test.local/workspaces/p1/artifacts/folders/f1"],
    ["DELETE", "http://test.local/workspaces/p1/artifacts/folders/f1"],
    ["GET", "http://test.local/workspaces/p1/artifacts?folder_id=root"],
    ["PATCH", "http://test.local/workspaces/p1/artifacts/a1"],
  ]);
  expect(calls[1]!.body).toEqual({
    name: "Launch",
    icon: "🚀",
    icon_glyph: null,
  });
  expect(calls[2]!.body).toEqual({
    name: "Archive",
    icon: null,
    icon_glyph: { name: "folder", color: "grey" },
  });
  expect(calls[5]!.body).toEqual({ folder_id: null });
});

test('deleteArtifactFolder rejects an HTTP permission failure', async () => {
  configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });
  globalThis.fetch = mock(async () => Response.json({ error: 'Forbidden' }, { status: 403 })) as unknown as typeof fetch;
  await expect(api.deleteArtifactFolder('p1', 'f1')).rejects.toThrow();
});

test('a folder is created inside another and moved between parents', async () => {
  const calls: { method: string; body: unknown }[] = [];
  configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });
  globalThis.fetch = mock(async (_url: unknown, opts: RequestInit = {}) => {
    calls.push({ method: opts.method ?? 'GET', body: opts.body ? JSON.parse(String(opts.body)) : undefined });
    return Response.json({ folder_id: 'child', parent_folder_id: 'parent', name: 'Q4', project_id: 'p1', icon: null, icon_glyph: null, can_manage: true });
  }) as unknown as typeof fetch;
  const created: api.ArtifactFolder = await api.createArtifactFolder('p1', { name: 'Q4', parent_folder_id: 'parent' });
  await api.updateArtifactFolder('p1', 'child', { parent_folder_id: null });
  expect(created.parent_folder_id).toBe('parent');
  expect(calls.map((c) => c.body)).toEqual([{ name: 'Q4', parent_folder_id: 'parent' }, { parent_folder_id: null }]);
});
