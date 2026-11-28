// A shared (live) drive's region move copies onto a shared volume with plain
// file calls: every folder made, every file written with its mode. The tree
// read leaves out the staging of an unfinished shared upload, and keeps fold
// markers, which the moved drive still needs. Storage is a fake answering the
// volumes API; every volume is unfenced, so no database is read.
import { expect, mock, test } from 'bun:test';

type Entry = { path: string; type: 'file' | 'dir'; size: number; mtime: number };
const files = new Map<string, Map<string, { bytes: Uint8Array; mode: number }>>();
const dirs = new Map<string, Set<string>>();
const calls: string[] = [];

function volumeOf(name: string) {
  if (!files.has(name)) {
    files.set(name, new Map());
    dirs.set(name, new Set());
  }
  return { files: files.get(name)!, dirs: dirs.get(name)! };
}

async function fakeStorage(path: string, init: RequestInit = {}): Promise<Response> {
  const method = (init.method ?? 'GET').toUpperCase();
  const url = new URL(path, 'http://storage');
  calls.push(`${method} ${url.pathname}${url.search}`);
  const m = /^\/v1\/volumes\/([^/]+)(\/.*)?$/.exec(url.pathname)!;
  const v = volumeOf(decodeURIComponent(m[1]!));
  const sub = m[2] ?? '';
  const p = url.searchParams.get('path') ?? '/';
  if (sub === '/files' && method === 'GET') {
    const entries: Entry[] = [
      ...[...v.dirs].map((d) => ({ path: d, type: 'dir' as const, size: 0, mtime: 1 })),
      ...[...v.files].map(([f, b]) => ({ path: f, type: 'file' as const, size: b.bytes.byteLength, mtime: 2 })),
    ];
    return Response.json({ entries, next_cursor: null });
  }
  if (sub === '/files/folder' && method === 'POST') {
    v.dirs.add((JSON.parse(String(init.body)) as { path: string }).path);
    return Response.json({ outcome: 'created', commit_id: null }, { status: 201 });
  }
  if (sub === '/files/content' && method === 'PUT') {
    const bytes = new Uint8Array(await new Response(init.body as BodyInit).arrayBuffer());
    v.files.set(p, { bytes, mode: Number.parseInt(url.searchParams.get('mode') ?? '644', 8) });
    return Response.json({ path: p, size: bytes.byteLength, commit_id: null }, { status: 201 });
  }
  if (sub === '/files/content' && method === 'GET') return new Response(new Uint8Array(v.files.get(p)!.bytes));
  if (sub === '/files/stat') return Response.json({ path: p, type: 'file', size: v.files.get(p)!.bytes.byteLength, mtime: 2, mode: 0o100000 | v.files.get(p)!.mode, version: 'x' });
  if (sub === '/files/upload') return Response.json({ error: 'shared', code: 'sharedfs_unsupported' }, { status: 422 });
  return Response.json({ code: 'not_found' }, { status: 404 });
}

mock.module('../shared/platinum', () => ({
  isPlatinumConfigured: () => true,
  platinumRegionControlPlane: () => 'http://storage',
  platinumFetch: fakeStorage,
}));

const { copyTreeShared, readTree } = await import('./region-move');

test('a shared drive moves onto a shared volume with its folders, bytes and modes, never through the block upload', async () => {
  const from = { name: 'kd-a', region: null, unfenced: true as const };
  const to = { name: 'kd-a-us', region: 'us', unfenced: true as const };
  const src = volumeOf(from.name);
  for (const d of ['/A', '/A/empty', '/A/x', '/.kortix-folded', '/.kortix-uploads', '/.kortix-uploads/sfs-1']) src.dirs.add(d);
  src.files.set('/A/x/run.sh', { bytes: new Uint8Array([1, 2, 3]), mode: 0o755 });
  src.files.set('/A/note.md', { bytes: new Uint8Array([4]), mode: 0o644 });
  src.files.set('/.kortix-folded/d1', { bytes: new Uint8Array(), mode: 0o644 });
  src.files.set('/.kortix-uploads/sfs-1/plan.json', { bytes: new Uint8Array([9]), mode: 0o644 });

  const tree = await readTree(from);
  expect(tree.dirs.sort()).toEqual(['/.kortix-folded', '/A', '/A/empty', '/A/x']);
  expect(tree.files.map((f) => f.path).sort()).toEqual(['/.kortix-folded/d1', '/A/note.md', '/A/x/run.sh']);

  const hashes = await copyTreeShared(from, to, tree);
  expect(hashes.size).toBe(3);
  const dst = volumeOf(to.name);
  expect([...dst.dirs].sort()).toEqual(['/.kortix-folded', '/A', '/A/empty', '/A/x']);
  expect(dst.files.get('/A/x/run.sh')).toEqual({ bytes: new Uint8Array([1, 2, 3]), mode: 0o755 });
  expect(dst.files.get('/A/note.md')?.mode).toBe(0o644);
  expect(calls.some((c) => c.includes('/files/upload'))).toBe(false);
  // Every folder is made, the empty one too.
  const made = calls.filter((c) => c.startsWith('POST /v1/volumes/kd-a-us/files/folder'));
  expect(made).toHaveLength(4);
});
