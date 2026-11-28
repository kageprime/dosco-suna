// Drives on shared (live) volumes: the create, the open of a volume of
// either type, and the calls a shared volume refuses (block upload, folder
// usage) taken on its live path. A fake storage answers both types the way
// the volumes API does; nothing here needs a database (every volume is
// unfenced).
import { createHash } from 'node:crypto';
import { afterEach, expect, mock, test } from 'bun:test';

type Vol = { id: string; type: 'block' | 'sharedfs'; head: string | null; files: Map<string, Uint8Array>; stamp?: string | null; dirs?: Set<string>; ver?: number };

let served = false;
let vols = new Map<string, Vol>();
let calls: string[] = [];
let queries: string[] = [];
let uploads = new Map<string, { vol: string; files: Array<{ path: string; blocks: string[] }> }>();
let blocks = new Map<string, Uint8Array>();
let commits = 0;

const json = (body: unknown, status = 200) => Response.json(body, { status });
const refuse = (status: number, code: string) => json({ error: code, code }, status);
const info = (name: string, v: Vol) => ({
  id: v.id, name, type: v.type, head_commit_id: v.head, logical_bytes: 0, file_count: v.files.size, last_commit_at: null,
  ...(v.stamp !== undefined ? { head_stamp: v.stamp } : {}),
});
const bytesOf = async (body: unknown) => new Uint8Array(await new Response(body as BodyInit).arrayBuffer());

function commit(v: Vol) {
  if (v.type === 'block') v.head = `c${++commits}`;
}

async function fakeStorage(path: string, init: RequestInit = {}): Promise<Response> {
  const method = (init.method ?? 'GET').toUpperCase();
  const url = new URL(path, 'http://storage');
  calls.push(`${method} ${url.pathname}`);
  queries.push(url.search);
  if (/^\/v1\/sandboxes\/[^/]+\/volumes\//.test(url.pathname) && method === 'POST') return refuse(409, 'sharedfs_writers_full');
  if (url.pathname === '/v1/volumes' && method === 'POST') {
    const body = JSON.parse(String(init.body)) as { name: string; type?: string };
    if (vols.has(body.name)) return refuse(409, 'volume_exists');
    if (body.type === 'sharedfs' && !served) return refuse(503, 'sharedfs_unavailable');
    const v: Vol = { id: `vol-${body.name}`, type: body.type === 'sharedfs' ? 'sharedfs' : 'block', head: null, files: new Map() };
    vols.set(body.name, v);
    return json(info(body.name, v), 201);
  }
  const m = /^\/v1\/volumes\/([^/]+)(\/.*)?$/.exec(url.pathname);
  if (!m) return refuse(404, 'not_found');
  const name = decodeURIComponent(m[1]!);
  const sub = m[2] ?? '';
  let v = vols.get(name);
  if (sub === '' && method === 'PUT') {
    const created = !v;
    v ??= { id: `vol-${name}`, type: 'block', head: null, files: new Map() };
    vols.set(name, v);
    return json(info(name, v), created ? 201 : 200);
  }
  if (!v) return refuse(404, 'volume_not_found');
  const p = url.searchParams.get('path') ?? '/';
  if (sub === '' && method === 'GET') return json(info(name, v));
  if (sub === '/usage') {
    const sizes = [...v.files.values()].reduce((a, b) => a + b.byteLength, 0);
    return json({ used_bytes: sizes, file_count: v.files.size, last_change_at: `t${calls.length}`, too_large: false });
  }
  if (sub === '/commits' && method === 'GET') return json({ commits: v.type === 'sharedfs' ? [{ id: `sc${v.ver ?? 0}` }] : [] });
  if (sub === '/files/content' && method === 'GET' && url.searchParams.get('at') === 'gone') return refuse(409, 'read_point_gone');
  if (sub === '/files/usage') return v.type === 'sharedfs' ? refuse(422, 'sharedfs_unsupported') : json({ bytes: 7, complete: true });
  if (sub === '/files/content' && method === 'PUT') {
    if (url.searchParams.get('overwrite') === 'false' && v.files.has(p)) return refuse(409, 'path_exists');
    const bytes = await bytesOf(init.body);
    v.files.set(p, bytes);
    commit(v);
    return json({ path: p, size: bytes.byteLength, version: `v${calls.length}` }, 201);
  }
  if (sub === '/files/content' && method === 'GET') {
    const bytes = v.files.get(p);
    return bytes ? new Response(new Uint8Array(bytes)) : refuse(404, 'not_found');
  }
  if (sub === '/files' && method === 'GET') {
    const dir = p.endsWith('/') ? p : `${p}/`;
    const entries = new Map<string, { path: string; type: string; size: number; mtime: number }>();
    for (const [fp, b] of v.files) {
      if (!fp.startsWith(dir)) continue;
      const [first, ...rest] = fp.slice(dir.length).split('/');
      const child = `${dir}${first}`;
      entries.set(child, rest.length ? { path: child, type: 'dir', size: 0, mtime: 0 } : { path: child, type: 'file', size: b.byteLength, mtime: 0 });
    }
    if (!entries.size) return refuse(404, 'not_found');
    return json({ entries: [...entries.values()], next_cursor: null });
  }
  if (sub === '/files/folder' && method === 'POST') {
    (v.dirs ??= new Set()).add(String((JSON.parse(String(init.body)) as { path: string }).path));
    return json({ outcome: 'created', commit_id: null }, 201);
  }
  if (sub === '/files' && method === 'DELETE') {
    for (const fp of [...v.files.keys()]) if (fp === p || fp.startsWith(`${p}/`)) v.files.delete(fp);
    commit(v);
    return json({});
  }
  if (sub === '/files/upload' && method === 'POST') {
    if (v.type === 'sharedfs') return refuse(422, 'sharedfs_unsupported');
    const plan = JSON.parse(String(init.body)) as { files: Array<{ path: string; blocks: string[] }> };
    const id = `upl_${uploads.size + 1}`;
    uploads.set(id, { vol: name, files: plan.files });
    return json({ upload_id: id, missing: [...new Set(plan.files.flatMap((f) => f.blocks))] });
  }
  const block = /^\/files\/upload\/([^/]+)\/blocks\/([0-9a-f]{64})$/.exec(sub);
  if (block && method === 'PUT') {
    blocks.set(block[2]!, await bytesOf(init.body));
    return new Response(null, { status: 204 });
  }
  const done = /^\/files\/upload\/([^/]+)\/commit$/.exec(sub);
  if (done && method === 'POST') {
    const up = uploads.get(done[1]!);
    if (!up) return refuse(404, 'upload_not_found');
    for (const f of up.files) v.files.set(f.path, Buffer.concat(f.blocks.map((b) => blocks.get(b)!)));
    commit(v);
    return json({ commit_id: v.head, outcome: 'fast', files: up.files.length });
  }
  return refuse(404, 'not_found');
}

mock.module('../shared/platinum', () => ({
  isPlatinumConfigured: () => true,
  platinumRegionControlPlane: () => null,
  platinumFetch: fakeStorage,
}));

const {
  openDriveVolume, knownVolumeType, planVolumeUpload, putVolumeUploadBlock, commitVolumeUpload,
  writeVolumeFiles, driveVolumeHead, volumeFolderUsage, readVolumeFile, listVolumeFiles, DriveStorageError,
  attachSandboxVolume, makeVolumeFolder, writeVolumeFile, isKortixInternalPath, isSharedUploadStaging,
} = await import('./volumes');

let n = 0;
/** A fresh volume name per test: the module's type memory is per name. */
const fresh = () => ({ name: `drive-${++n}`, region: null, unfenced: true as const });
const MIB = 1024 * 1024;
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
function blocksOf(bytes: Uint8Array) {
  const out: Array<{ sha: string; bytes: Uint8Array<ArrayBuffer> }> = [];
  for (let off = 0; off < bytes.byteLength; off += MIB) {
    const b = new Uint8Array(bytes.subarray(off, off + MIB));
    out.push({ sha: sha(b), bytes: b });
  }
  return out;
}
const fileOf = (size: number, seed: number) => Uint8Array.from({ length: size }, (_, i) => (i * 31 + seed) % 251);
async function text(volume: ReturnType<typeof fresh>, path: string) {
  return new Uint8Array(await (await readVolumeFile(volume, path)).arrayBuffer());
}

afterEach(() => {
  served = false;
  vols = new Map();
  calls = [];
  queries = [];
  uploads = new Map();
  blocks = new Map();
});

test('an open without preferShared is the one PUT it always was', async () => {
  served = true;
  const volume = fresh();
  await openDriveVolume(volume);
  expect(calls).toEqual([`PUT /v1/volumes/${volume.name}`]);
  expect(vols.get(volume.name)?.type).toBe('block');
});

test('shared volumes off: a new drive still gets the block volume it gets today', async () => {
  const volume = fresh();
  const opened = await openDriveVolume(volume, undefined, { preferShared: true });
  expect(opened.type).toBe('block');
  expect(vols.get(volume.name)?.type).toBe('block');
  expect(calls).toEqual([`GET /v1/volumes/${volume.name}`, 'POST /v1/volumes', `PUT /v1/volumes/${volume.name}`]);
  expect(knownVolumeType(volume.name)).toBe('block');
});

test('shared volumes on: a new drive is created as a shared volume', async () => {
  served = true;
  const volume = fresh();
  const opened = await openDriveVolume(volume, undefined, { preferShared: true });
  expect(opened.type).toBe('sharedfs');
  expect(calls).toEqual([`GET /v1/volumes/${volume.name}`, 'POST /v1/volumes']);
  expect(knownVolumeType(volume.name)).toBe('sharedfs');
});

test('an existing drive opens as it is, block or shared, and is never re-created', async () => {
  served = true;
  const block = fresh();
  const shared = fresh();
  vols.set(block.name, { id: 'b', type: 'block', head: 'c0', files: new Map() });
  vols.set(shared.name, { id: 's', type: 'sharedfs', head: null, files: new Map() });
  expect((await openDriveVolume(block, undefined, { preferShared: true })).type).toBe('block');
  expect((await openDriveVolume(shared, undefined, { preferShared: true })).type).toBe('sharedfs');
  expect(calls.filter((c) => c === 'POST /v1/volumes')).toEqual([]);
});

test('a block volume keeps the storage block upload, untouched', async () => {
  const volume = fresh();
  vols.set(volume.name, { id: 'b', type: 'block', head: null, files: new Map() });
  const bytes = fileOf(MIB + 10, 1);
  const parts = blocksOf(bytes);
  const plan = (await planVolumeUpload(volume, { files: [{ path: '/A/big.bin', size: bytes.byteLength, blocks: parts.map((p) => p.sha) }], overwrite: true })) as { upload_id: string };
  expect(plan.upload_id).toBe('upl_1');
  for (const p of parts) await putVolumeUploadBlock(volume, plan.upload_id, p.sha, p.bytes);
  await commitVolumeUpload(volume, plan.upload_id);
  expect(await text(volume, '/A/big.bin')).toEqual(bytes);
});

test('a drive converted to a shared volume in place: the block upload runs on file writes and lands the same bytes', async () => {
  const volume = fresh();
  // Known as block to this process, converted since: the plan is refused, then taken on the live path.
  vols.set(volume.name, { id: 'b', type: 'block', head: 'c0', files: new Map() });
  await openDriveVolume(volume);
  vols.get(volume.name)!.type = 'sharedfs';
  const bytes = fileOf(2 * MIB + 5, 2);
  const parts = blocksOf(bytes);
  const plan = (await planVolumeUpload(volume, { files: [{ path: '/A/big.bin', size: bytes.byteLength, blocks: parts.map((p) => p.sha) }], overwrite: true })) as {
    upload_id: string; missing: string[]; expires_at: string;
  };
  expect(plan.upload_id).toMatch(/^sfs-\d{13}-[0-9a-f]{16}-[0-9a-f]{32}$/);
  expect(plan.missing.sort()).toEqual(parts.map((p) => p.sha).sort());
  expect(knownVolumeType(volume.name)).toBe('sharedfs');
  for (const p of parts) await putVolumeUploadBlock(volume, plan.upload_id, p.sha, p.bytes);
  expect(await commitVolumeUpload(volume, plan.upload_id)).toEqual({ outcome: 'written', commit_id: null, files: 1 });
  expect(await text(volume, '/A/big.bin')).toEqual(bytes);
  // The staging folder is gone, and the same commit again finds no upload.
  expect([...vols.get(volume.name)!.files.keys()].filter((p) => p.startsWith('/.kortix-uploads'))).toEqual([]);
  const again = await commitVolumeUpload(volume, plan.upload_id).catch((e: unknown) => e);
  expect(again).toBeInstanceOf(DriveStorageError);
  expect((again as InstanceType<typeof DriveStorageError>).status).toBe(404);
});

test('a shared upload refuses a block that does not match its sha256, and a commit with a block missing', async () => {
  served = true;
  const volume = fresh();
  await openDriveVolume(volume, undefined, { preferShared: true });
  const bytes = fileOf(MIB + 1, 3);
  const parts = blocksOf(bytes);
  const plan = (await planVolumeUpload(volume, { files: [{ path: '/A/f.bin', size: bytes.byteLength, blocks: parts.map((p) => p.sha) }] })) as { upload_id: string };
  const bad = await putVolumeUploadBlock(volume, plan.upload_id, parts[0]!.sha, parts[1]!.bytes).catch((e: unknown) => e);
  expect((bad as InstanceType<typeof DriveStorageError>).code).toBe('block_mismatch');
  await putVolumeUploadBlock(volume, plan.upload_id, parts[0]!.sha, parts[0]!.bytes);
  const early = await commitVolumeUpload(volume, plan.upload_id).catch((e: unknown) => e);
  expect((early as InstanceType<typeof DriveStorageError>).code).toBe('upload_incomplete');
  expect(vols.get(volume.name)!.files.has('/A/f.bin')).toBe(false);
});

test('many files on a shared volume are written one by one; on a block volume as one commit', async () => {
  served = true;
  const shared = fresh();
  await openDriveVolume(shared, undefined, { preferShared: true });
  const files = [{ path: '/A/x/index.md', bytes: fileOf(10, 4) }, { path: '/A/x/b.txt', bytes: fileOf(20, 5) }];
  expect(await writeVolumeFiles(shared, files, { overwrite: false })).toBeUndefined();
  expect(calls.filter((c) => c.endsWith('/files/upload'))).toEqual([]);
  expect(await text(shared, '/A/x/b.txt')).toEqual(files[1]!.bytes);
  const taken = await writeVolumeFiles(shared, files, { overwrite: false }).catch((e: unknown) => e);
  expect((taken as InstanceType<typeof DriveStorageError>).status).toBe(409);

  const block = fresh();
  vols.set(block.name, { id: 'b', type: 'block', head: null, files: new Map() });
  const landed = await writeVolumeFiles(block, files, { overwrite: false });
  expect(landed?.commit_id).toMatch(/^c\d+$/);
  expect(await text(block, '/A/x/index.md')).toEqual(files[0]!.bytes);
});

test('the head: a block volume answers its head commit; a shared volume a token that moves with its files and no commit to read at', async () => {
  const block = fresh();
  vols.set(block.name, { id: 'b', type: 'block', head: 'c41', files: new Map() });
  expect(await driveVolumeHead(block)).toEqual({ token: 'c41', commit: 'c41' });

  const shared = fresh();
  // Converted in place: the old head commit stays on the row and never moves again.
  vols.set(shared.name, { id: 's', type: 'sharedfs', head: 'c7', files: new Map() });
  const before = await driveVolumeHead(shared);
  expect(before.commit).toBeNull();
  expect(before.token).toStartWith('live:');
  await writeVolumeFiles(shared, [{ path: '/A/n.txt', bytes: fileOf(3, 6) }], { overwrite: true });
  expect((await driveVolumeHead(shared)).token).not.toBe(before.token);
});

test('folder usage: a block volume asks storage; a shared volume has none to ask for', async () => {
  const block = fresh();
  vols.set(block.name, { id: 'b', type: 'block', head: 'c1', files: new Map() });
  expect(await volumeFolderUsage(block, '/A')).toEqual({ bytes: 7, complete: true });
  const shared = fresh();
  vols.set(shared.name, { id: 's', type: 'sharedfs', head: 'c1', files: new Map() });
  expect(await volumeFolderUsage(shared, '/A')).toBeNull();
  // Now known: not asked again.
  calls = [];
  expect(await volumeFolderUsage(shared, '/A')).toBeNull();
  expect(calls).toEqual([]);
});

test('listing a shared staging folder never needs the listing memo', async () => {
  served = true;
  const volume = fresh();
  await openDriveVolume(volume, undefined, { preferShared: true });
  const bytes = fileOf(5, 7);
  const parts = blocksOf(bytes);
  const plan = (await planVolumeUpload(volume, { files: [{ path: '/A/s.bin', size: 5, blocks: parts.map((p) => p.sha) }] })) as { upload_id: string };
  const staged = await listVolumeFiles(volume, `/.kortix-uploads/${plan.upload_id}`, false, AbortSignal.timeout(1_000));
  expect(staged.map((e) => e.path)).toEqual([`/.kortix-uploads/${plan.upload_id}/plan.json`]);
});

test('the head of a shared volume is storage\'s head stamp when it has one, else the token from its usage', async () => {
  const shared = fresh();
  vols.set(shared.name, { id: 's', type: 'sharedfs', head: 'c7', files: new Map(), stamp: '0000000000000000002a' });
  expect(await driveVolumeHead(shared)).toEqual({ token: 'stamp:0000000000000000002a', commit: null });
  // One call: the stamp needs no usage read.
  expect(calls).toEqual([`GET /v1/volumes/${shared.name}`]);
  vols.get(shared.name)!.stamp = '0000000000000000002b';
  expect((await driveVolumeHead(shared)).token).toBe('stamp:0000000000000000002b');
  // Never written, or storage could not read it: the usage token, as before.
  vols.get(shared.name)!.stamp = null;
  expect((await driveVolumeHead(shared)).token).toStartWith('live:');
  // A block volume's head is its head commit, whatever else it carries.
  const block = fresh();
  vols.set(block.name, { id: 'b', type: 'block', head: 'c9', files: new Map() });
  expect(await driveVolumeHead(block)).toEqual({ token: 'c9', commit: 'c9' });
});

test('a shared volume with every writer slot taken refuses a mount as busy, not as a name clash', async () => {
  const err = await attachSandboxVolume('sbx-1', '/drives/Files', { volume: fresh(), readOnly: false }).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(DriveStorageError);
  expect((err as InstanceType<typeof DriveStorageError>).status).toBe(409);
  expect((err as InstanceType<typeof DriveStorageError>).code).toBe('sharedfs_writers_full');
  expect((err as Error).message).not.toContain('already exists');
});

test('a folder is made with its parents, and a write may carry the file\'s mode', async () => {
  served = true;
  const volume = fresh();
  await openDriveVolume(volume, undefined, { preferShared: true });
  await makeVolumeFolder(volume, '/A/empty');
  expect([...vols.get(volume.name)!.dirs!]).toEqual(['/A/empty']);
  await writeVolumeFile(volume, '/A/run.sh', fileOf(4, 8), { overwrite: false, mode: 0o100755 });
  expect(new URLSearchParams(queries.at(-1)).get('mode')).toBe('755');
  // Without a mode the write is the one it always was.
  await writeVolumeFile(volume, '/A/b.txt', fileOf(4, 9), { overwrite: false });
  expect(new URLSearchParams(queries.at(-1)).has('mode')).toBe(false);
});

test('Kortix\'s own bookkeeping at a drive\'s root is known by its path', () => {
  expect(['/.kortix-uploads/sfs-1/plan.json', '/.kortix-folded/d1', '/.kortix'].every(isKortixInternalPath)).toBe(true);
  expect(['/A/.kortix-uploads', '/kortix', '/Users/a/.kortix-x'].some(isKortixInternalPath)).toBe(false);
  expect(isSharedUploadStaging('/.kortix-uploads/sfs-1/abc')).toBe(true);
  expect(isSharedUploadStaging('/.kortix-uploads')).toBe(true);
  expect(isSharedUploadStaging('/.kortix-folded/d1')).toBe(false);
});

test('without a stamp, a shared drive\'s token moves with its newest version even when its usage does not (a rename)', async () => {
  served = true;
  const shared = fresh();
  await openDriveVolume(shared, undefined, { preferShared: true });
  const v = vols.get(shared.name);
  expect(v?.type).toBe('sharedfs');
  v!.stamp = null; v!.ver = 1;
  const before = (await driveVolumeHead(shared)).token;
  v!.ver = 2; // a rename: same files, same bytes, a new version
  const after = (await driveVolumeHead(shared)).token;
  expect(before).toStartWith('live:sc1:');
  expect(after).toStartWith('live:sc2:');
});

test('a version storage no longer keeps is not found, not a name clash', async () => {
  const shared = fresh();
  await openDriveVolume(shared, undefined, { preferShared: true });
  const err = await readVolumeFile(shared, '/a.txt', undefined, 'gone').catch((e) => e);
  expect(err).toBeInstanceOf(DriveStorageError);
  expect(err.status).toBe(404);
  expect(err.code).toBe('read_point_gone');
});

async function sharedUploadOf(bytes: Uint8Array) {
  const volume = fresh();
  vols.set(volume.name, { id: 'b', type: 'block', head: 'c0', files: new Map() });
  await openDriveVolume(volume);
  vols.get(volume.name)!.type = 'sharedfs';
  const parts = blocksOf(bytes);
  const plan = (await planVolumeUpload(volume, { files: [{ path: '/A/f.bin', size: bytes.byteLength, blocks: parts.map((p) => p.sha) }], overwrite: true })) as { upload_id: string };
  return { volume, parts, plan };
}

test('a block the sealed plan does not name is refused, never staged', async () => {
  const { volume, plan } = await sharedUploadOf(fileOf(MIB + 3, 4));
  const stray = new Uint8Array(1024).fill(7);
  const err = await putVolumeUploadBlock(volume, plan.upload_id, sha(stray), stray).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(DriveStorageError);
  expect((err as InstanceType<typeof DriveStorageError>).code).toBe('block_not_in_plan');
  expect([...vols.get(volume.name)!.files.keys()].some((k) => k.endsWith(sha(stray)))).toBe(false);
});

test('a plan rewritten on the volume after planning is refused at block and commit', async () => {
  const { volume, parts, plan } = await sharedUploadOf(fileOf(MIB + 3, 5));
  const files = vols.get(volume.name)!.files;
  const planPath = [...files.keys()].find((k) => k.endsWith('/plan.json'))!;
  // A session with the drive mounted points the upload at another path.
  const forged = JSON.parse(new TextDecoder().decode(files.get(planPath)!));
  forged.files[0].path = '/Secrets/overwritten.bin';
  files.set(planPath, new TextEncoder().encode(JSON.stringify(forged)));
  const atBlock = await putVolumeUploadBlock(volume, plan.upload_id, parts[0]!.sha, parts[0]!.bytes).catch((e: unknown) => e);
  expect((atBlock as InstanceType<typeof DriveStorageError>).code).toBe('upload_tampered');
  const atCommit = await commitVolumeUpload(volume, plan.upload_id).catch((e: unknown) => e);
  expect((atCommit as InstanceType<typeof DriveStorageError>).code).toBe('upload_tampered');
  expect(files.has('/Secrets/overwritten.bin')).toBe(false);
});
