/**
 * Harbor Hub (hub.harborframework.com): Harbor's package registry, where a
 * task or a dataset is a package `org/name`, published in versions.
 *
 *   ref:     `latest` or another tag, a revision number (`3`), or a content
 *            digest (`sha256:<64 hex>`). No ref is `latest`.
 *   task:    a version is one archive (a gzip tar of the task folder) in the
 *            Hub's storage, addressed by the task's content hash.
 *   dataset: a version is a list of task versions, each by content hash.
 *
 * Reads are anonymous: the Hub is a Supabase project that grants public
 * packages to its publishable key. A job pins every task to its content hash
 * when it is planned, so a rerun reads the same files even after `latest` moves.
 */
import { gunzipSync } from 'node:zlib';
import { EVAL_LIMITS } from '@kortix/api-contract';
import { ttlMemo } from '../../shared/ttl-memo';
import { EvalTrialError } from './scoring';

/** The Hub's Supabase project and its publishable (public, read-only) key, as Harbor ships them in `src/harbor/auth/constants.py`. */
const HUB_URL = 'https://ofhuhcpkvzjlejydnvyd.supabase.co';
const HUB_PUBLISHABLE_KEY = 'sb_publishable_Z-vuQbpvpG-PStjbh4yE0Q_e-d3MTIH';
const HUB_TIMEOUT_MS = 30_000;
const ARCHIVE_TIMEOUT_MS = 120_000;
/** PostgREST answers at most this many rows per request. */
const PAGE = 1_000;

/** Harbor's `ORG_NAME_PATTERN`. */
const PACKAGE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]*\/[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const TAG = /^[a-z0-9][a-z0-9.-]*$/;
const HASH = /^[0-9a-f]{64}$/;

export type HubRef = { type: 'tag'; value: string } | { type: 'revision'; value: number } | { type: 'digest'; value: string };

export interface HubPackage {
  org: string;
  name: string;
  ref: HubRef;
}

/** A task version of the Hub: what a trial needs to read its files again. */
export interface HubTaskVersion {
  org: string;
  name: string;
  /** sha256 of the task's content (hex), the version's identity. */
  content_hash: string;
  /** The archive's object path in the `packages` bucket. */
  archive_path: string;
}

/** Whether a dataset or task name is a Hub package (`org/name`, optionally `@ref`). Harbor reads a name with `/` as a package. */
export const isHubName = (value: string): boolean => PACKAGE_NAME.test(value.split('@')[0] ?? '');

/** `latest`, `stable`, `3`, `sha256:<hex>` as Harbor's `VersionRef.parse` reads them. */
export function parseHubRef(raw: string | null | undefined): HubRef {
  const ref = (raw ?? '').trim();
  if (!ref || ref === 'latest') return { type: 'tag', value: 'latest' };
  if (/^\d+$/.test(ref)) return { type: 'revision', value: Number(ref) };
  if (ref.startsWith('sha256:')) {
    if (!DIGEST.test(ref)) throw new EvalTrialError('TaskLoadError', `Not a full sha256 digest: ${ref}. Write sha256: and 64 hex characters.`);
    return { type: 'digest', value: ref };
  }
  if (!TAG.test(ref)) throw new EvalTrialError('TaskLoadError', `Not a Harbor Hub tag: ${ref}. A tag is lowercase letters, digits, dots and hyphens.`);
  return { type: 'tag', value: ref };
}

export const hubRefText = (ref: HubRef): string => String(ref.value);

/** `org/name`, `org/name@ref`, or `org/name` with a separate ref (a source's `version`). Both refs at once is an error. */
export function parseHubPackage(value: string, separateRef?: string | null): HubPackage {
  const at = value.indexOf('@');
  const name = at >= 0 ? value.slice(0, at) : value;
  const inlineRef = at >= 0 ? value.slice(at + 1) : null;
  if (!PACKAGE_NAME.test(name) || name.includes('..')) {
    throw new EvalTrialError('TaskLoadError', `Not a Harbor Hub package name: ${value}. Write org/name, optionally @tag, @revision or @sha256:<digest>.`);
  }
  if (inlineRef !== null && separateRef) throw new EvalTrialError('TaskLoadError', `${value} names a version twice: drop @${inlineRef} or \`version: ${separateRef}\`.`);
  const [org, short] = name.split('/') as [string, string];
  return { org, name: short, ref: parseHubRef(inlineRef ?? separateRef) };
}

async function hubJson<T>(path: string, init?: { method?: 'GET' | 'POST'; body?: unknown }): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${HUB_URL}${path}`, {
      method: init?.method ?? 'GET',
      headers: {
        apikey: HUB_PUBLISHABLE_KEY,
        Authorization: `Bearer ${HUB_PUBLISHABLE_KEY}`,
        ...(init?.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(HUB_TIMEOUT_MS),
    });
  } catch (err) {
    throw new EvalTrialError('TaskLoadError', `Harbor Hub did not answer: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) throw new EvalTrialError('TaskLoadError', `Harbor Hub answered ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  return (await res.json()) as T;
}

/** Every row of a PostgREST select, a page at a time. */
async function selectAll<T>(table: string, query: string, order: string): Promise<T[]> {
  const out: T[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const rows = await hubJson<T[]>(`/rest/v1/${table}?${query}&order=${order}&offset=${offset}&limit=${PAGE}`);
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
}

const enc = encodeURIComponent;

// ── Datasets ─────────────────────────────────────────────────────────────────

interface DatasetVersionRow {
  id: string;
  content_hash: string;
  revision: number | string;
  description: string | null;
  readme?: string | null;
  yanked_at: string | null;
  package: { name: string; org: { name: string } };
  dataset_version_task?: Array<{ count: number }>;
  dataset_version_tag?: Array<{ tag: string }>;
}

export interface HubDatasetSummary {
  name: string;
  /** The revision `latest` points at (or the newest one). */
  version: string;
  /** Revisions that are not yanked, newest first. */
  versions: string[];
  description: string;
  n_tasks: number | null;
}

const PACKAGE_SELECT = 'package:package_id!inner(name,type,org:org_id!inner(name))';

/** Every dataset package of the Hub, one row per dataset. Cached 10 minutes. */
export const listHubDatasets = ttlMemo<[], HubDatasetSummary[]>({
  ttlMs: 10 * 60_000,
  keyFn: () => 'hub-datasets',
  loader: async () => {
    const rows = await selectAll<DatasetVersionRow>(
      'dataset_version',
      `select=id,content_hash,revision,description,yanked_at,${PACKAGE_SELECT},dataset_version_task(count),dataset_version_tag(tag)&package.type=eq.dataset`,
      'id',
    );
    const byName = new Map<string, DatasetVersionRow[]>();
    for (const row of rows) {
      const name = `${row.package.org.name}/${row.package.name}`;
      byName.set(name, [...(byName.get(name) ?? []), row]);
    }
    const out: HubDatasetSummary[] = [];
    for (const [name, versions] of byName) {
      const live = versions.filter((row) => !row.yanked_at).sort((a, b) => Number(b.revision) - Number(a.revision));
      if (live.length === 0) continue;
      const latest = live.find((row) => row.dataset_version_tag?.some((tag) => tag.tag === 'latest')) ?? live[0]!;
      out.push({
        name,
        version: String(latest.revision),
        versions: live.map((row) => String(row.revision)),
        description: latest.description ?? '',
        n_tasks: latest.dataset_version_task?.[0]?.count ?? null,
      });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  },
});

export interface HubDatasetVersion {
  id: string;
  name: string;
  revision: number;
  content_hash: string;
  description: string;
  readme: string | null;
}

/** One version of a dataset package, by tag, revision or digest. */
export async function resolveHubDataset(pkg: HubPackage): Promise<HubDatasetVersion> {
  const name = `${pkg.org}/${pkg.name}`;
  const where = `package.name=eq.${enc(pkg.name)}&package.type=eq.dataset&package.org.name=eq.${enc(pkg.org)}`;
  const version = `id,content_hash,revision,description,readme,yanked_at`;
  let row: DatasetVersionRow | undefined;
  if (pkg.ref.type === 'tag') {
    const rows = await hubJson<Array<{ dataset_version: DatasetVersionRow | null }>>(
      `/rest/v1/dataset_version_tag?select=dataset_version:dataset_version_id(${version}),${PACKAGE_SELECT}&tag=eq.${enc(pkg.ref.value)}&${where}&limit=1`,
    );
    row = rows[0]?.dataset_version ?? undefined;
  } else {
    const filter = pkg.ref.type === 'revision' ? `revision=eq.${pkg.ref.value}` : `content_hash=eq.${pkg.ref.value.slice('sha256:'.length)}`;
    row = (await hubJson<DatasetVersionRow[]>(`/rest/v1/dataset_version?select=${version},${PACKAGE_SELECT}&${filter}&${where}&limit=1`))[0];
  }
  if (!row) throw new EvalTrialError('TaskLoadError', `Harbor Hub has no dataset ${name}@${hubRefText(pkg.ref)}.`);
  if (!HASH.test(row.content_hash)) throw new EvalTrialError('TaskLoadError', `Harbor Hub returned a malformed version of ${name}.`);
  return { id: row.id, name, revision: Number(row.revision), content_hash: row.content_hash, description: row.description ?? '', readme: row.readme ?? null };
}

interface DatasetTaskRow {
  task_version_id: string;
  task_version: { content_hash: string; archive_path: string; package: { name: string; org: { name: string } } | null } | null;
}

/** The task versions of one dataset version. A task the Hub does not show (private, deleted) fails the whole dataset, as in Harbor. */
export async function hubDatasetTasks(version: HubDatasetVersion): Promise<HubTaskVersion[]> {
  const rows = await selectAll<DatasetTaskRow>(
    'dataset_version_task',
    `select=task_version_id,task_version:task_version_id(content_hash,archive_path,package:package_id(name,org:org_id(name)))&dataset_version_id=eq.${enc(version.id)}`,
    'task_version_id',
  );
  const missing = rows.filter((row) => !row.task_version?.package).length;
  if (missing) throw new EvalTrialError('TaskLoadError', `${version.name}@${version.revision}: ${missing} of its tasks are not readable on Harbor Hub.`);
  return rows.map((row) => checkedTaskVersion({ org: row.task_version!.package!.org.name, name: row.task_version!.package!.name, content_hash: row.task_version!.content_hash, archive_path: row.task_version!.archive_path }));
}

// ── Tasks ────────────────────────────────────────────────────────────────────

/** A task version as the Hub names it, checked: a well-formed name and hash, and its archive under its own package folder. */
export function checkedTaskVersion(task: HubTaskVersion): HubTaskVersion {
  const ok =
    PACKAGE_NAME.test(`${task.org}/${task.name}`) &&
    !`${task.org}/${task.name}`.includes('..') &&
    HASH.test(task.content_hash) &&
    task.archive_path.startsWith(`packages/${task.org}/${task.name}/${task.content_hash}/`) &&
    !task.archive_path.split('/').includes('..') &&
    /^[A-Za-z0-9._/-]+$/.test(task.archive_path);
  if (!ok) throw new EvalTrialError('TaskLoadError', `Harbor Hub returned a malformed task version for ${task.org}/${task.name}.`);
  return task;
}

/** One task package at a tag, revision or digest. */
export async function resolveHubTask(pkg: HubPackage): Promise<HubTaskVersion> {
  const row = await hubJson<{ content_hash?: string; archive_path?: string; yanked_at?: string | null } | null>('/rest/v1/rpc/resolve_task_version', {
    method: 'POST',
    body: { p_org: pkg.org, p_name: pkg.name, p_ref: pkg.ref.type === 'tag' ? pkg.ref.value : String(pkg.ref.value) },
  }).catch((err) => {
    throw err instanceof EvalTrialError ? new EvalTrialError('TaskLoadError', `Harbor Hub has no task ${pkg.org}/${pkg.name}@${hubRefText(pkg.ref)} (${err.message}).`) : err;
  });
  if (!row?.content_hash || !row.archive_path) throw new EvalTrialError('TaskLoadError', `Harbor Hub has no task ${pkg.org}/${pkg.name}@${hubRefText(pkg.ref)}.`);
  return checkedTaskVersion({ org: pkg.org, name: pkg.name, content_hash: row.content_hash, archive_path: row.archive_path });
}

// ── Archives ─────────────────────────────────────────────────────────────────

/** Bytes of one extracted task: every file, the environment's included. */
export const HUB_TASK_BYTES_MAX = 4 * EVAL_LIMITS.task_folder_bytes_max;

export interface ExtractedTask {
  files: Map<string, Uint8Array<ArrayBuffer>>;
  /** Entries left out: links that point outside the task, devices, FIFOs. */
  skipped: string[];
}

const decoder = new TextDecoder();
const field = (block: Uint8Array, start: number, length: number): string => {
  const raw = decoder.decode(block.subarray(start, start + length));
  const nul = raw.indexOf('\0');
  return nul >= 0 ? raw.slice(0, nul) : raw;
};
const octal = (block: Uint8Array, start: number, length: number): number => {
  // GNU base-256 for sizes above 8 GB: far over any limit here.
  if ((block[start]! & 0x80) !== 0) return Number.POSITIVE_INFINITY;
  const text = field(block, start, length).trim();
  return text ? Number.parseInt(text, 8) : 0;
};

/** `a/./b/` → `a/b`; null for an absolute path, a `..` segment or an empty path. */
function cleanEntryPath(raw: string): string | null {
  if (raw.startsWith('/') || raw.includes('\\') || /^[A-Za-z]:/.test(raw)) return null;
  const parts = raw.split('/').filter((part) => part && part !== '.');
  if (parts.length === 0 || parts.includes('..')) return null;
  return parts.join('/');
}

/** Read the `path` (and `linkpath`) records of a pax extended header. */
function paxRecords(bytes: Uint8Array): Record<string, string> {
  const out: Record<string, string> = {};
  const text = decoder.decode(bytes);
  let at = 0;
  while (at < text.length) {
    const space = text.indexOf(' ', at);
    if (space < 0) break;
    const length = Number(text.slice(at, space));
    if (!Number.isFinite(length) || length <= 0) break;
    const record = text.slice(space + 1, at + length - 1);
    const eq = record.indexOf('=');
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1);
    at += length;
  }
  return out;
}

/**
 * Extract a gzip tar of a task folder into memory. Refuses an absolute path or
 * a `..` segment, and a total over `maxBytes`. A link becomes a copy of the
 * file it names inside the archive; one that points outside it (or at nothing)
 * is left out, as are devices and FIFOs: what Python's `data` filter allows.
 */
export function extractTaskArchive(gzipped: Uint8Array, maxBytes = HUB_TASK_BYTES_MAX): ExtractedTask {
  let tar: Uint8Array;
  try {
    tar = gunzipSync(gzipped, { maxOutputLength: maxBytes + 1024 * 1024 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new EvalTrialError('TaskLoadError', /maxOutputLength|buffer|larger/i.test(message) ? `The task archive is larger than ${maxBytes / 1024 / 1024} MB.` : `The task archive is not a gzip file: ${message}`);
  }
  const files = new Map<string, Uint8Array<ArrayBuffer>>();
  const links: Array<{ path: string; target: string }> = [];
  const skipped: string[] = [];
  let total = 0;
  let longName: string | null = null;
  let longLink: string | null = null;
  let pax: Record<string, string> = {};
  for (let at = 0; at + 512 <= tar.length; ) {
    const header = tar.subarray(at, at + 512);
    if (header.every((byte) => byte === 0)) break;
    const size = octal(header, 124, 12);
    const type = String.fromCharCode(header[156] ?? 48);
    if (!Number.isFinite(size) || size < 0 || at + 512 + size > tar.length) throw new EvalTrialError('TaskLoadError', 'The task archive is truncated or malformed.');
    const body = tar.subarray(at + 512, at + 512 + size);
    at += 512 + Math.ceil(size / 512) * 512;
    if (type === 'L') { longName = field(body, 0, body.length); continue; }
    if (type === 'K') { longLink = field(body, 0, body.length); continue; }
    if (type === 'x') { pax = paxRecords(body); continue; }
    if (type === 'g') continue;
    const prefix = field(header, 345, 155);
    const rawName = pax.path ?? longName ?? (prefix ? `${prefix}/${field(header, 0, 100)}` : field(header, 0, 100));
    const rawLink = pax.linkpath ?? longLink ?? field(header, 157, 100);
    longName = longLink = null;
    pax = {};
    if (type === '5') continue;
    const path = cleanEntryPath(rawName);
    if (!path) throw new EvalTrialError('TaskLoadError', `The task archive has an unsafe path: ${rawName.slice(0, 200)}`);
    if (type === '0' || type === '\0' || type === '7') {
      total += size;
      if (total > maxBytes) throw new EvalTrialError('TaskLoadError', `The task archive is larger than ${maxBytes / 1024 / 1024} MB.`);
      files.set(path, new Uint8Array(body) as Uint8Array<ArrayBuffer>);
    } else if (type === '1' || type === '2') {
      // A hardlink names a path from the archive root; a symlink is relative to its own folder.
      const base = type === '2' && !rawLink.startsWith('/') ? path.split('/').slice(0, -1).join('/') : '';
      const target = rawLink.startsWith('/') ? null : cleanEntryPath(base ? `${base}/${rawLink}` : rawLink) ?? resolveDots(base, rawLink);
      if (target) links.push({ path, target });
      else skipped.push(path);
    } else {
      skipped.push(path);
    }
  }
  // Links to files inside the archive become copies; a chain is followed a few steps.
  for (let round = 0; round < 8 && links.length; round += 1) {
    for (let i = links.length - 1; i >= 0; i -= 1) {
      const bytes = files.get(links[i]!.target);
      if (!bytes) continue;
      total += bytes.byteLength;
      if (total > maxBytes) throw new EvalTrialError('TaskLoadError', `The task archive is larger than ${maxBytes / 1024 / 1024} MB.`);
      files.set(links[i]!.path, bytes);
      links.splice(i, 1);
    }
  }
  skipped.push(...links.map((link) => link.path));
  return { files, skipped };
}

/** `base` joined with a relative link that may climb with `..`, or null when it climbs out of the archive. */
function resolveDots(base: string, link: string): string | null {
  const parts = base ? base.split('/') : [];
  for (const part of link.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(part);
  }
  return parts.length ? parts.join('/') : null;
}

// replica-local: extracted task archives of this process by content hash, most recently read last; a miss downloads again.
const extracted = new Map<string, Promise<ExtractedTask>>();
/** Extracted tasks kept in memory per process; the least recently read go first. */
const EXTRACTED_MAX = 64;

/** The files of one task version, downloaded once per process and kept by content hash. */
export function hubTaskFiles(task: HubTaskVersion): Promise<ExtractedTask> {
  const checked = checkedTaskVersion(task);
  const cached = extracted.get(checked.content_hash);
  if (cached) {
    extracted.delete(checked.content_hash);
    extracted.set(checked.content_hash, cached);
    return cached;
  }
  const run = (async () => {
    let res: Response;
    try {
      res = await fetch(`${HUB_URL}/storage/v1/object/packages/${checked.archive_path}`, {
        headers: { apikey: HUB_PUBLISHABLE_KEY, Authorization: `Bearer ${HUB_PUBLISHABLE_KEY}` },
        signal: AbortSignal.timeout(ARCHIVE_TIMEOUT_MS),
      });
    } catch (err) {
      throw new EvalTrialError('TaskLoadError', `Could not download ${checked.org}/${checked.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!res.ok) throw new EvalTrialError('TaskLoadError', `Could not download ${checked.org}/${checked.name}: Harbor Hub answered ${res.status}.`);
    const length = Number(res.headers.get('content-length') ?? 0);
    if (length > HUB_TASK_BYTES_MAX) throw new EvalTrialError('TaskLoadError', `The archive of ${checked.org}/${checked.name} is larger than ${HUB_TASK_BYTES_MAX / 1024 / 1024} MB.`);
    return extractTaskArchive(new Uint8Array(await res.arrayBuffer()));
  })();
  run.catch(() => extracted.delete(checked.content_hash));
  extracted.set(checked.content_hash, run);
  while (extracted.size > EXTRACTED_MAX) extracted.delete(extracted.keys().next().value!);
  return run;
}
