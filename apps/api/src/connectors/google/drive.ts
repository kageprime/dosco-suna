/**
 * Kortix Google Drive MCP server tools. Names and arguments follow Composio's
 * Google Drive toolkit (`find_file`, `download_file`, `create_permission`, …);
 * see ./tool.ts.
 *
 * Scope: `drive` (full Drive). It also covers the Sheets, Docs, Slides and
 * Forms calls that Composio's Drive toolkit carries. Every call passes
 * `supportsAllDrives=true` and every file list `includeItemsFromAllDrives=true`,
 * so shared drives work everywhere; Composio's `supportsAllDrives` arguments
 * are accepted and ignored. The tools Composio built on Drive API v2
 * (parents, children, properties, `get_file_v2`, …) call v2 too.
 *
 * Files: an upload takes Composio's `file_to_upload` ({name, mimetype,
 * content | url}) or one `attachments` item, up to {@link MAX_FILE_BYTES},
 * sent as one multipart request. A download comes back as base64
 * (`file.content_base64`); Google Docs, Sheets and Slides are exported, as
 * PDF unless `mime_type` names another format.
 *
 * There is no free-form `request` tool: every Drive call goes through a named
 * tool, so per-tool policy rules hold.
 */
import { randomUUID } from 'node:crypto';
import { GoogleApiError } from './client';
import { FILE_ITEM_SCHEMA, MAX_FILE_BYTES, fileOutput, guessMimeType, resolveFile, resolveFiles, type FileInput } from './files';
import {
  DESTRUCTIVE,
  READ,
  ToolInputError,
  WRITE,
  anyObj,
  arr,
  b,
  i,
  mapLimit,
  optInt,
  optObj,
  optStr,
  pick,
  reqStr,
  s,
  schema,
  strList,
  strs,
  type GoogleTool,
  type ToolAnnotations,
  type ToolContext,
} from './tool';

const D = 'https://www.googleapis.com/drive/v3';
const D2 = 'https://www.googleapis.com/drive/v2';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';
const DOCS = 'https://docs.googleapis.com/v1/documents';
const SLIDES = 'https://slides.googleapis.com/v1/presentations';
const FORMS = 'https://forms.googleapis.com/v1/forms';
const LABELS = 'https://drivelabels.googleapis.com/v2/labels';

const FOLDER = 'application/vnd.google-apps.folder';
const SHORTCUT = 'application/vnd.google-apps.shortcut';
const WORKSPACE = 'application/vnd.google-apps.';

/** The fields a create, copy, move, trash or update answers with. */
const FILE_FIELDS =
  'kind,id,name,mimeType,description,parents,driveId,size,createdTime,modifiedTime,webViewLink,webContentLink,iconLink,starred,trashed,trashedTime,explicitlyTrashed,shared,ownedByMe,owners(displayName,emailAddress)';
/** find_file's default: enough to pick a file, without permissions or capabilities. */
const FIND_FIELDS = 'kind,nextPageToken,incompleteSearch,files(id,name,mimeType,size,modifiedTime,createdTime,parents,webViewLink,trashed,starred)';
const FOLDER_FIELDS = 'kind,nextPageToken,incompleteSearch,files(id,name,mimeType,parents,driveId,description,createdTime,modifiedTime,starred,webViewLink)';
const META_FIELDS = 'id,name,mimeType,size,webViewLink,exportLinks,shortcutDetails';
const LIST_KEYS = new Set(['kind', 'nextPageToken', 'incompleteSearch', 'files']);

const ROLES = ['owner', 'organizer', 'fileOrganizer', 'writer', 'commenter', 'reader'];
const GRANTEES = ['user', 'group', 'domain', 'anyone'];

const IDEMPOTENT: ToolAnnotations = { ...WRITE, idempotentHint: true };
const REMOVE: ToolAnnotations = { ...DESTRUCTIVE, idempotentHint: true };

type Json = Record<string, unknown>;
type Props = Record<string, Record<string, unknown>>;

const enc = encodeURIComponent;
const filePath = (fileId: string) => `${D}/files/${enc(fileId)}`;
const file2Path = (fileId: string) => `${D2}/files/${enc(fileId)}`;

// ─── Arguments ──────────────────────────────────────────────────────────────

/** A boolean from the first key that holds one; `undefined` when none does. */
function flag(args: Json, ...keys: string[]): boolean | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'boolean') return value;
    if (value === 'true' || value === 'false') return value === 'true';
  }
  return undefined;
}

function int(args: Json, keys: readonly string[], fallback?: number, max?: number): number | undefined {
  for (const key of keys) {
    const value = optInt(args, key, undefined, max);
    if (value !== undefined) return value;
  }
  return fallback;
}

/** Every paginated tool takes both spellings. */
const pageToken = (args: Json) => optStr(args, 'pageToken', 'page_token');

/** An id; a Drive, Docs, Sheets, Slides or Forms URL yields the id inside it. */
function idFrom(value: string): string {
  const text = value.trim();
  if (!/^https?:\/\//i.test(text)) return text;
  const match = /\/(?:d|folders|drives)\/([A-Za-z0-9_-]{10,})/.exec(text) ?? /[?&]id=([A-Za-z0-9_-]{10,})/.exec(text);
  return match?.[1] ?? text;
}

/** A required id; `keys` lists Composio's name first, then aliases. */
const idArg = (args: Json, ...keys: string[]) => idFrom(reqStr(args, ...keys));

/** A value inside a single-quoted Drive query string. */
function quote(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/** An array argument, or a JSON array passed as a string. */
function arrayArg(args: Json, key: string): unknown[] | undefined {
  const value = args[key];
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'string' && value.trim().startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new ToolInputError(`${key} must be a JSON array`);
    }
    if (Array.isArray(parsed)) return parsed;
  }
  throw new ToolInputError(`${key} must be an array`);
}

/** Folder ids from an array or a comma-separated string. */
const idList = (args: Json, ...keys: string[]) => strList(args, ...keys).map(idFrom);

// ─── Links ──────────────────────────────────────────────────────────────────

const EDITORS: Record<string, string> = {
  'application/vnd.google-apps.document': 'document',
  'application/vnd.google-apps.spreadsheet': 'spreadsheets',
  'application/vnd.google-apps.presentation': 'presentation',
  'application/vnd.google-apps.form': 'forms',
  'application/vnd.google-apps.drawing': 'drawings',
};

function viewUrl(fileId: string, mimeType = ''): string {
  if (mimeType === FOLDER) return `https://drive.google.com/drive/folders/${fileId}`;
  const editor = EDITORS[mimeType];
  if (editor) return `https://docs.google.com/${editor}/d/${fileId}/edit`;
  return mimeType ? `https://drive.google.com/file/d/${fileId}/view` : `https://drive.google.com/open?id=${fileId}`;
}

/** The file plus `display_url`: its webViewLink, or a link built from its id. */
function withLink(file: Json | null, fallbackId = ''): Json {
  if (!file) return {};
  const fileId = typeof file.id === 'string' ? file.id : fallbackId;
  const mimeType = typeof file.mimeType === 'string' ? file.mimeType : '';
  const link = typeof file.webViewLink === 'string' ? file.webViewLink : fileId ? viewUrl(fileId, mimeType) : '';
  return link ? { ...file, display_url: link } : file;
}

const driveLink = (drive: Json | null): Json =>
  drive && typeof drive.id === 'string' ? { ...drive, display_url: `https://drive.google.com/drive/folders/${drive.id}` } : (drive ?? {});

// ─── Search queries ─────────────────────────────────────────────────────────

const QUERY_TERM =
  /\b(?:name|title|fullText|mimeType|modifiedTime|modifiedDate|viewedByMeTime|createdTime|createdDate|sharedWithMeTime|trashed|starred|sharedWithMe|hidden|visibility|properties|appProperties|shortcutDetails\.targetId|memberCount|organizerCount)\s*(?:!=|<=|>=|=|<|>|contains\b|has\b)/i;
const IN_TERM = /\bin\s+(?:parents|owners|writers|readers)\b/i;
const EMAIL = /^[^\s@'"()]+@[^\s@'"()]+\.[^\s@'"()]+$/;
const PERSON_COLON = /\b(owner|writer|reader)s?:\s*'?([^\s@'"()]+@[^\s@'"()]+?)'?(?=\s|\)|$)/gi;
const DOUBLE_QUOTED_VALUE = /(!=|<=|>=|=|<|>|\bcontains|\bhas)\s*"([^"]*)"/gi;
const DOUBLE_QUOTED_IN = /"([^"]*)"(\s+in\s+(?:parents|owners|writers|readers)\b)/gi;
/** What may follow the quote that closes a value. Any other quote is an apostrophe inside it. */
const CLOSES_VALUE = /^(?:\s*$|\s*[),}]|\s+(?:and|or|not|in|has)\b)/i;

/** Escape apostrophes inside quoted values: `name = 'Valentine's Day'` → `name = 'Valentine\'s Day'`. */
function escapeStrayQuotes(q: string): string {
  let out = '';
  let inValue = false;
  for (let k = 0; k < q.length; k++) {
    const c = q[k]!;
    if (!inValue) {
      out += c;
      if (c === "'") inValue = true;
    } else if (c === '\\') {
      out += c + (q[k + 1] ?? '');
      k++;
    } else if (c === "'") {
      if (CLOSES_VALUE.test(q.slice(k + 1))) {
        out += c;
        inValue = false;
      } else {
        out += "\\'";
      }
    } else {
      out += c;
    }
  }
  return out;
}

/**
 * A Drive `q` from what an agent wrote. Drive syntax passes through with
 * apostrophes in values escaped; bare text becomes a fullText search and a bare
 * email address an owner search, as Composio did.
 */
function driveQuery(raw: string | undefined): string | undefined {
  const q = raw?.trim();
  if (!q) return undefined;
  const fixed = q
    .replace(PERSON_COLON, (_all, field: string, email: string) => `'${quote(email)}' in ${field.toLowerCase()}s`)
    .replace(DOUBLE_QUOTED_VALUE, (_all, op: string, value: string) => `${op} '${quote(value)}'`)
    .replace(DOUBLE_QUOTED_IN, (_all, value: string, rest: string) => `'${quote(value)}'${rest}`);
  if (!QUERY_TERM.test(fixed) && !IN_TERM.test(fixed)) {
    const text = q.replace(/^(['"])([\s\S]*)\1$/, '$2');
    return EMAIL.test(text) ? `'${quote(text)}' in owners` : `fullText contains '${quote(text)}'`;
  }
  return escapeStrayQuotes(fixed);
}

/** Join query terms with `and`, bracketing a term that has an `or`. */
function andQuery(...terms: Array<string | undefined>): string | undefined {
  const set = terms.filter((t): t is string => Boolean(t));
  if (set.length <= 1) return set[0];
  return set.map((t) => (/\bor\b/i.test(t) ? `(${t})` : t)).join(' and ');
}

function splitFields(fields: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const c of fields) {
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (c === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
    } else {
      current += c;
    }
  }
  parts.push(current.trim());
  return parts.filter(Boolean);
}

/**
 * files.list `fields`. Drive syntax (`*`, `files(…)`, `nextPageToken,…`) passes
 * verbatim; bare file fields (`id,name`) go inside files(…), as Composio did.
 */
function listFields(raw: string | undefined, fallback: string): string {
  const fields = raw?.trim();
  if (!fields) return fallback;
  const parts = splitFields(fields);
  if (fields === '*' || parts.some((p) => LIST_KEYS.has(p.split(/[(/]/)[0]!.trim()))) return fields;
  // `editors` and a bare `emailAddress` are not File fields in v3; Composio dropped them.
  const inner = parts.map((p) => (p === 'alternateLink' ? 'webViewLink' : p)).filter((p) => p !== 'editors' && p !== 'emailAddress');
  return inner.length ? `kind,nextPageToken,incompleteSearch,files(${inner.join(',')})` : fallback;
}

async function listFiles(ctx: ToolContext, args: Json, q: string | undefined, fields: string, corpora: string | undefined): Promise<Json> {
  const driveId = optStr(args, 'driveId', 'drive_id');
  const scope = driveId ? 'drive' : corpora;
  let orderBy = optStr(args, 'orderBy', 'order_by')?.replace(/\bsize\b/g, 'quotaBytesUsed');
  // Drive refuses to sort a fullText search.
  if (q && /\bfullText\b/.test(q)) orderBy = undefined;
  const result = await ctx.google.json<Json>({
    url: `${D}/files`,
    query: {
      q,
      fields,
      orderBy,
      driveId,
      corpora: scope,
      spaces: optStr(args, 'spaces'),
      pageSize: int(args, ['pageSize', 'page_size'], 100, 1000),
      pageToken: pageToken(args),
      includeLabels: optStr(args, 'include_labels', 'includeLabels'),
      includePermissionsForView: optStr(args, 'include_permissions_for_view', 'includePermissionsForView'),
      supportsAllDrives: true,
      includeItemsFromAllDrives: scope === 'drive' || scope === 'allDrives' || (flag(args, 'includeItemsFromAllDrives', 'include_items_from_all_drives') ?? true),
    },
  });
  return { ...result, files: result?.files ?? [] };
}

/** A folder id from an id, a URL or an exact folder name (first match). */
async function folderId(ctx: ToolContext, value: string): Promise<string> {
  const raw = idFrom(value);
  if (raw === 'root') return raw;
  if (/^[A-Za-z0-9_-]{10,}$/.test(raw)) {
    try {
      const folder = await ctx.google.json<{ mimeType?: string }>({ url: filePath(raw), query: { fields: 'id,mimeType', supportsAllDrives: true } });
      if (folder?.mimeType !== FOLDER) throw new ToolInputError(`${raw} is a ${folder?.mimeType ?? 'file'}, not a folder`);
      return raw;
    } catch (error) {
      if (!(error instanceof GoogleApiError && error.status === 404)) throw error;
    }
  }
  const found = await ctx.google.json<{ files?: Array<{ id: string }> }>({
    url: `${D}/files`,
    query: {
      q: `mimeType = '${FOLDER}' and name = '${quote(raw)}' and trashed = false`,
      fields: 'files(id)',
      pageSize: 1,
      corpora: 'allDrives',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    },
  });
  const match = found?.files?.[0]?.id;
  if (!match) throw new ToolInputError(`No folder has the id or exact name "${raw}". Find it with find_folder, or create it first.`);
  return match;
}

// ─── Downloads ──────────────────────────────────────────────────────────────

interface DriveMeta {
  id?: string;
  name?: string;
  mimeType?: string;
  size?: string;
  webViewLink?: string;
  exportLinks?: Record<string, string>;
  shortcutDetails?: { targetId?: string };
}

/** Extension → export MIME type. The first extension of a type names exported files. */
const EXPORT_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation',
  rtf: 'application/rtf',
  txt: 'text/plain',
  text: 'text/plain',
  html: 'text/html',
  zip: 'application/zip',
  epub: 'application/epub+zip',
  md: 'text/markdown',
  markdown: 'text/markdown',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  svg: 'image/svg+xml',
  json: 'application/vnd.google-apps.script+json',
  mp4: 'video/mp4',
};

/** Composio's default export when mime_type is omitted: PDF, or JSON for Apps Script. */
const DEFAULT_EXPORT: Record<string, string> = {
  'application/vnd.google-apps.document': 'application/pdf',
  'application/vnd.google-apps.spreadsheet': 'application/pdf',
  'application/vnd.google-apps.presentation': 'application/pdf',
  'application/vnd.google-apps.drawing': 'application/pdf',
  'application/vnd.google-apps.jam': 'application/pdf',
  'application/vnd.google-apps.script': 'application/vnd.google-apps.script+json',
};

/** A MIME type, or an extension such as `docx` turned into one. */
function exportType(value: string | undefined): string | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  return text.includes('/') ? text : (EXPORT_TYPES[text.toLowerCase().replace(/^\./, '')] ?? text);
}

function exportName(name: string, mimeType: string): string {
  const ext = Object.keys(EXPORT_TYPES).find((key) => EXPORT_TYPES[key] === mimeType);
  return ext && !name.toLowerCase().endsWith(`.${ext}`) ? `${name}.${ext}` : name;
}

function tooLarge(name: string, size: number, link: string): ToolInputError {
  return new ToolInputError(
    `${name} is ${size} bytes; Kortix returns files up to ${MAX_FILE_BYTES} bytes (25 MB). Open or share it from Drive instead: ${link}`,
  );
}

/** File metadata; a shortcut resolves to its target. */
async function fileMeta(ctx: ToolContext, fileId: string): Promise<DriveMeta> {
  const query = { fields: META_FIELDS, supportsAllDrives: true };
  const meta = await ctx.google.json<DriveMeta>({ url: filePath(fileId), query });
  const target = meta?.mimeType === SHORTCUT ? meta.shortcutDetails?.targetId : undefined;
  if (target) return (await ctx.google.json<DriveMeta>({ url: filePath(target), query })) ?? {};
  return meta ?? {};
}

interface Content {
  meta: DriveMeta;
  exported: boolean;
  mimeType: string;
  name: string;
  /** `null` when the export is over Google's 10 MB export limit. */
  data: Uint8Array | null;
}

/** A file's bytes: a Workspace file is exported (`exportMime`, PDF by default), any other file comes as stored. */
async function fileContent(ctx: ToolContext, fileId: string, exportMime: string | undefined, workspaceOnly = false): Promise<Content> {
  const meta = await fileMeta(ctx, fileId);
  const id = meta.id ?? fileId;
  const mimeType = meta.mimeType ?? '';
  const name = meta.name ?? id;
  const link = meta.webViewLink ?? viewUrl(id, mimeType);
  if (mimeType.startsWith(WORKSPACE)) {
    if (mimeType === FOLDER) throw new ToolInputError(`${name} is a folder. List its files with find_file and folder_id=${id}.`);
    const target = exportMime ?? DEFAULT_EXPORT[mimeType];
    if (!target) throw new ToolInputError(`Google Drive cannot export ${mimeType} files. Open it at ${link}.`);
    try {
      const { data } = await ctx.google.bytes({ url: `${filePath(id)}/export`, query: { mimeType: target } });
      if (data.byteLength > MAX_FILE_BYTES) throw tooLarge(name, data.byteLength, link);
      return { meta, exported: true, mimeType: target, name: exportName(name, target), data };
    } catch (error) {
      if (error instanceof GoogleApiError && error.reason === 'exportSizeLimitExceeded') {
        return { meta, exported: true, mimeType: target, name: exportName(name, target), data: null };
      }
      throw error;
    }
  }
  if (workspaceOnly) {
    throw new ToolInputError(`${name} is a ${mimeType || 'stored'} file, not a Google Docs, Sheets, Slides or Drawings file. Download it with download_file.`);
  }
  const size = Number(meta.size ?? 0);
  if (size > MAX_FILE_BYTES) throw tooLarge(name, size, link);
  const { data, contentType } = await ctx.google.bytes({ url: filePath(id), query: { alt: 'media', supportsAllDrives: true } });
  if (data.byteLength > MAX_FILE_BYTES) throw tooLarge(name, data.byteLength, link);
  return { meta, exported: false, mimeType: mimeType || contentType.split(';')[0]!.trim(), name, data };
}

const EXPORT_LIMIT_NOTE = 'Google exports files up to 10 MB. Open export_link in a browser, or export a smaller format (such as text/plain or text/csv).';

// ─── Uploads ────────────────────────────────────────────────────────────────

const UPLOAD_ITEM = {
  type: 'object',
  properties: {
    name: s('File name, such as report.pdf.'),
    mimetype: s('MIME type, such as application/pdf. Guessed from the name when omitted.'),
    content: s('The file as base64, or a Kortix attachment reference {"$kortix_attachment": "<id>"}.'),
    url: s('A public https URL Kortix downloads instead of `content`.'),
  },
};

const uploadProp = (description: string) => ({
  ...UPLOAD_ITEM,
  description: `${description} Pass {name, mimetype, content} or {name, url}. Composio s3key references do not work here.`,
});

const ATTACHMENTS = arr(FILE_ITEM_SCHEMA, 'Instead of file_to_upload: one file. `kortix connectors call --attach <file>` puts it here.');

/** The file of `key` (Composio's `file_to_upload`), else the one `attachments` item. */
async function uploadArg(args: Json, key: string): Promise<FileInput | undefined> {
  const value = optObj(args, key) ?? args[key];
  if (value !== undefined && value !== null && value !== '') return resolveFile(value, key);
  const files = await resolveFiles(args);
  if (files.length > 1) throw new ToolInputError('Upload one file per call: attachments holds more than one');
  return files[0];
}

async function requireUpload(args: Json, key: string): Promise<FileInput> {
  const file = await uploadArg(args, key);
  if (!file) throw new ToolInputError(`${key} is required: {name, mimetype, content} with base64 content, or {name, url}`);
  return file;
}

/** The media part's type. A Workspace type belongs in the metadata (it converts); the media keeps the real type. */
const mediaType = (mimeType: string, filename: string) => (mimeType.startsWith(WORKSPACE) ? guessMimeType(filename) : mimeType);

function multipartBody(metadata: Json, type: string, data: Uint8Array): { contentType: string; data: Uint8Array } {
  const boundary = `kortix_${randomUUID()}`;
  const text = new TextEncoder();
  const head = text.encode(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${type}\r\n\r\n`,
  );
  const tail = text.encode(`\r\n--${boundary}--\r\n`);
  const body = new Uint8Array(head.byteLength + data.byteLength + tail.byteLength);
  body.set(head, 0);
  body.set(data, head.byteLength);
  body.set(tail, head.byteLength + data.byteLength);
  return { contentType: `multipart/related; boundary=${boundary}`, data: body };
}

/**
 * Create (no `fileId`) or replace a file's content. Metadata and media go in one
 * multipart request; a content-only update is a media upload.
 */
async function uploadFile(
  ctx: ToolContext,
  opts: { fileId?: string; metadata: Json; media: { filename: string; mimeType: string; data: Uint8Array }; query?: Json; fields?: string },
): Promise<Json> {
  const withMetadata = !opts.fileId || Object.values(opts.metadata).some((v) => v !== undefined);
  const type = mediaType(opts.media.mimeType, opts.media.filename);
  const result = await ctx.google.json<Json>({
    method: opts.fileId ? 'PATCH' : 'POST',
    url: opts.fileId ? `${UPLOAD}/${enc(opts.fileId)}` : UPLOAD,
    query: { uploadType: withMetadata ? 'multipart' : 'media', supportsAllDrives: true, fields: opts.fields ?? FILE_FIELDS, ...opts.query },
    rawBody: withMetadata ? multipartBody(opts.metadata, type, opts.media.data) : { contentType: type, data: opts.media.data },
  });
  return withLink(result, opts.fileId);
}

// ─── Shared schema properties ───────────────────────────────────────────────

const FILE_ID = s('Drive file id. A Drive, Docs, Sheets or Slides URL works too.');
const FIELDS = s('Fields to return, comma-separated, such as `id,name,webViewLink`. `*` returns every field.');
const PAGE_TOKEN = s('nextPageToken of the previous page, unchanged. pageToken and page_token both work.');
const pageSize = (max: number, fallback?: number) => i(`Items per page, up to ${max}.`, fallback === undefined ? {} : { default: fallback });
const DOMAIN_ADMIN = b('Act as a Workspace administrator of the domain that owns the shared drive.');
const INCLUDE_LABELS = s('Label ids to include in labelInfo, comma-separated.');
const PUBLISHED_VIEW = s('`published` adds the permissions of the published view.');
const ROLE = s('owner, organizer, fileOrganizer, writer, commenter or reader.', { enum: ROLES });
const GRANTEE = s('user, group, domain or anyone (anyone with the link).', { enum: GRANTEES });

// ─── Search ─────────────────────────────────────────────────────────────────

const findFile: GoogleTool = {
  name: 'find_file',
  title: 'Find files',
  description:
    'Search files and folders in My Drive and shared drives. q takes Drive query syntax, such as ' +
    "`name contains 'report' and mimeType = 'application/pdf'`. Bare text searches names and content; a bare email address finds files that person owns. " +
    'folder_id limits the search to one folder (`root` is My Drive). Page with pageToken.',
  inputSchema: schema({
    q: s(
      "Drive query. Terms: name = or contains, fullText contains, mimeType = 'application/vnd.google-apps.folder', modifiedTime or createdTime > '2024-01-01T00:00:00', " +
        "'<folder id>' in parents, '<email>' in owners (writers, readers), trashed = false, starred = true, sharedWithMe = true. " +
        'Combine with and, or, not and parentheses. Apostrophes inside values are escaped for you.',
    ),
    folder_id: s('Only items directly inside this folder. `root` is My Drive.'),
    pageSize: pageSize(1000, 100),
    pageToken: PAGE_TOKEN,
    orderBy: s('Sort keys, such as `modifiedTime desc,name`. quotaBytesUsed sorts by size. Ignored for fullText searches.'),
    fields: s('Drive fields, such as `nextPageToken,files(id,name,webViewLink)`; bare names such as `id,name` go inside files(). `*` returns every field.'),
    corpora: s('user (My Drive and shared with me), domain, drive (needs driveId) or allDrives.', { enum: ['user', 'drive', 'domain', 'allDrives'], default: 'allDrives' }),
    driveId: s('Search only this shared drive.'),
    spaces: s('drive or appDataFolder.', { default: 'drive' }),
    includeItemsFromAllDrives: b('Include shared drive items.', { default: true }),
    include_labels: INCLUDE_LABELS,
    include_permissions_for_view: PUBLISHED_VIEW,
  }),
  annotations: READ,
  async run(args, ctx) {
    const folder = optStr(args, 'folder_id', 'folderId');
    const q = andQuery(folder ? `'${quote(idFrom(folder))}' in parents` : undefined, driveQuery(optStr(args, 'q', 'query')));
    return listFiles(ctx, args, q, listFields(optStr(args, 'fields'), FIND_FIELDS), optStr(args, 'corpora') ?? 'allDrives');
  },
};

const findFolder: GoogleTool = {
  name: 'find_folder',
  title: 'Find folders',
  description: 'Find folders by name, parent, star or modification date, in My Drive and shared drives. Trashed folders are left out. Page with page_token.',
  inputSchema: schema({
    name_exact: s('The exact folder name.'),
    name_contains: s('Text the name contains. Drive matches it from the start of words.'),
    name_not_contains: s('Leave out folders whose name contains this.'),
    full_text_contains: s("Text in the folder's name or description (not in the files inside it)."),
    full_text_not_contains: s("Leave out folders with this text in their name or description."),
    parent_folder_id: s('Only folders directly inside this folder.'),
    starred: b('True: starred folders only. False: unstarred only.'),
    modified_after: s("Only folders modified after this RFC 3339 time, such as '2024-01-15T10:00:00Z'."),
    page_size: pageSize(1000, 100),
    page_token: PAGE_TOKEN,
  }),
  annotations: READ,
  async run(args, ctx) {
    const terms = [`mimeType = '${FOLDER}'`, 'trashed = false'];
    const term = (key: string, make: (value: string) => string) => {
      const value = optStr(args, key);
      if (value !== undefined) terms.push(make(quote(value)));
    };
    term('name_exact', (v) => `name = '${v}'`);
    term('name_contains', (v) => `name contains '${v}'`);
    term('name_not_contains', (v) => `not name contains '${v}'`);
    term('full_text_contains', (v) => `fullText contains '${v}'`);
    term('full_text_not_contains', (v) => `not fullText contains '${v}'`);
    term('modified_after', (v) => `modifiedTime > '${v}'`);
    const parent = optStr(args, 'parent_folder_id', 'folder_id');
    if (parent) terms.push(`'${quote(idFrom(parent))}' in parents`);
    const starred = flag(args, 'starred');
    if (starred !== undefined) terms.push(`starred = ${starred}`);
    return listFiles(ctx, args, terms.join(' and '), listFields(optStr(args, 'fields'), FOLDER_FIELDS), 'allDrives');
  },
};

const listFilesTool: GoogleTool = {
  name: 'list_files',
  title: 'List files',
  description: 'List files and folders, optionally inside one folder or matching a Drive query. find_file is the fuller search. Page with pageToken.',
  inputSchema: schema({
    folderId: s('Only items directly inside this folder. `root` is My Drive.'),
    q: s("Drive query, such as `mimeType = 'application/pdf' and trashed = false`."),
    pageSize: pageSize(1000, 100),
    pageToken: PAGE_TOKEN,
    orderBy: s('Sort keys, such as `modifiedTime desc`. quotaBytesUsed sorts by size.'),
    fields: s('File fields, such as `id,name,webViewLink`; they go inside files() for you.'),
    corpora: s('user (default), domain, drive (needs driveId) or allDrives.'),
    driveId: s('List only this shared drive.'),
    spaces: s('drive or appDataFolder.'),
    includeItemsFromAllDrives: b('Include shared drive items.', { default: true }),
    includeLabels: INCLUDE_LABELS,
    includePermissionsForView: PUBLISHED_VIEW,
  }),
  annotations: READ,
  async run(args, ctx) {
    const folder = optStr(args, 'folderId', 'folder_id');
    const q = andQuery(folder ? `'${quote(idFrom(folder))}' in parents` : undefined, driveQuery(optStr(args, 'q', 'query')));
    return listFiles(ctx, args, q, listFields(optStr(args, 'fields'), FIND_FIELDS), optStr(args, 'corpora'));
  },
};

const listChildrenV2: GoogleTool = {
  name: 'list_children_v2',
  title: 'List folder children (v2)',
  description: 'List the child references (ids only) of a folder with Drive API v2. find_file with folder_id returns names and types too.',
  inputSchema: schema(
    {
      folderId: s('Folder id. `root` is My Drive.'),
      q: s("Drive v2 query, such as `title contains 'report'`."),
      orderBy: s('Sort keys, such as `modifiedDate desc,title`.'),
      maxResults: i('Children per page.'),
      pageToken: PAGE_TOKEN,
      fields: s('ChildReference fields: id, selfLink, childLink, kind.'),
    },
    ['folderId'],
  ),
  annotations: READ,
  run: (args, ctx) =>
    ctx.google.json({
      url: `${file2Path(idArg(args, 'folderId', 'folder_id'))}/children`,
      query: {
        q: optStr(args, 'q'),
        orderBy: optStr(args, 'orderBy', 'order_by'),
        maxResults: int(args, ['maxResults', 'max_results', 'pageSize', 'page_size']),
        pageToken: pageToken(args),
        fields: optStr(args, 'fields'),
      },
    }),
};

// ─── Account, metadata, ids ─────────────────────────────────────────────────

const getAbout: GoogleTool = {
  name: 'get_about',
  title: 'Get Drive account info',
  description:
    'The signed-in user, the My Drive storage quota, and Drive limits and import/export formats. fields `user,storageQuota` returns only the first two. Quota numbers are byte strings.',
  inputSchema: schema({ fields: s('Fields to return, such as `user,storageQuota`. `*` returns every field.', { default: '*' }) }),
  annotations: READ,
  run: (args, ctx) => ctx.google.json({ url: `${D}/about`, query: { fields: optStr(args, 'fields') ?? '*' } }),
};

const getFileMetadata: GoogleTool = {
  name: 'get_file_metadata',
  title: 'Get file metadata',
  description:
    "A file's metadata. Without fields Google returns only id, name and mimeType: ask for more, such as `id,name,mimeType,parents,webViewLink,modifiedTime,size,owners`. download_file returns the content.",
  inputSchema: schema(
    { fileId: FILE_ID, fields: FIELDS, includeLabels: INCLUDE_LABELS, includePermissionsForView: PUBLISHED_VIEW },
    ['fileId'],
  ),
  annotations: READ,
  async run(args, ctx) {
    const fileId = idArg(args, 'fileId', 'file_id');
    const file = await ctx.google.json<Json>({
      url: filePath(fileId),
      query: {
        fields: optStr(args, 'fields')?.replace(/\balternateLink\b/g, 'webViewLink'),
        includeLabels: optStr(args, 'includeLabels', 'include_labels'),
        includePermissionsForView: optStr(args, 'includePermissionsForView', 'include_permissions_for_view'),
        supportsAllDrives: true,
      },
    });
    return withLink(file, fileId);
  },
};

const getFileV2: GoogleTool = {
  name: 'get_file_v2',
  title: 'Get file metadata (v2)',
  description: "A file's metadata in Drive API v2 form (title, labels, alternateLink, …). get_file_metadata is the v3 tool.",
  inputSchema: schema(
    {
      fileId: FILE_ID,
      fields: FIELDS,
      projection: s('BASIC or FULL (deprecated by Google).', { enum: ['BASIC', 'FULL'] }),
      revisionId: s('Read this revision instead of the head.'),
      acknowledgeAbuse: b('Acknowledge the risk of a file Google flags as abusive.'),
      updateViewedDate: b("Update the file's viewed date."),
      includeLabels: INCLUDE_LABELS,
      includePermissionsForView: PUBLISHED_VIEW,
    },
    ['fileId'],
  ),
  annotations: READ,
  async run(args, ctx) {
    const fileId = idArg(args, 'fileId', 'file_id');
    const file = await ctx.google.json<Json>({
      url: file2Path(fileId),
      query: {
        ...pick(args, ['fields', 'projection', 'revisionId', 'acknowledgeAbuse', 'updateViewedDate', 'includeLabels', 'includePermissionsForView']),
        supportsAllDrives: true,
      },
    });
    return { ...file, display_url: typeof file?.alternateLink === 'string' ? file.alternateLink : viewUrl(fileId) };
  },
};

const generateIds: GoogleTool = {
  name: 'generate_ids',
  title: 'Generate file ids',
  description: 'Reserve file ids to pass as `id` when creating or copying files.',
  inputSchema: schema({
    count: i('How many ids, 1–1000.', { default: 10 }),
    space: s('drive or appDataFolder.'),
    type: s('files or shortcuts.'),
  }),
  annotations: READ,
  run: (args, ctx) =>
    ctx.google.json({ url: `${D}/files/generateIds`, query: { count: int(args, ['count'], undefined, 1000), space: optStr(args, 'space'), type: optStr(args, 'type') } }),
};

const getApp: GoogleTool = {
  name: 'get_app',
  title: 'Get Drive app',
  description: 'One installed Drive app by id. `self` is the calling app.',
  inputSchema: schema({ appId: s('App id, or `self`.') }, ['appId']),
  annotations: READ,
  run: (args, ctx) => ctx.google.json({ url: `${D}/apps/${enc(reqStr(args, 'appId', 'app_id'))}` }),
};

// ─── Download and export ────────────────────────────────────────────────────

const downloadFile: GoogleTool = {
  name: 'download_file',
  title: 'Download file',
  description:
    "Download a file's content as base64 (`file.content_base64`). Stored files (PDF, images, Office) come as they are. " +
    'Google Docs, Sheets, Slides and Drawings are exported: as PDF, or as mime_type (such as text/plain, text/markdown, text/csv, docx, xlsx). ' +
    'Files over 25 MB are refused; for a large one pass `--out result.json` to `kortix connectors call`.',
  inputSchema: schema(
    {
      fileId: FILE_ID,
      mime_type: s('Export format for a Google Workspace file: a MIME type or an extension such as pdf, docx, md, csv. Ignored for stored files.'),
    },
    ['fileId'],
  ),
  annotations: READ,
  async run(args, ctx) {
    const content = await fileContent(ctx, idArg(args, 'fileId', 'file_id'), exportType(optStr(args, 'mime_type', 'mimeType')));
    const id = content.meta.id ?? '';
    const exportLink = content.exported ? (content.meta.exportLinks?.[content.mimeType] ?? null) : null;
    return {
      id,
      kind: 'drive#file',
      name: content.meta.name ?? '',
      mimeType: content.meta.mimeType ?? '',
      export_applied: content.exported,
      ...(content.exported ? { export_mime_type: content.mimeType, export_link: exportLink } : {}),
      export_size_limit_exceeded: content.data === null,
      ...(content.data === null ? { message: EXPORT_LIMIT_NOTE } : {}),
      file: content.data ? fileOutput(content.name, content.mimeType, content.data) : null,
      display_url: content.meta.webViewLink ?? viewUrl(id, content.meta.mimeType),
    };
  },
};

const exportWorkspaceFile: GoogleTool = {
  name: 'export_google_workspace_file',
  title: 'Export Google Docs, Sheets or Slides file',
  description:
    'Export a Google Docs, Sheets, Slides, Drawings or Apps Script file to another format, as base64 (`file.content_base64`). ' +
    'Docs: docx, odt, rtf, pdf, txt, html, epub, md. Sheets: xlsx, ods, pdf, csv, tsv (first sheet). Slides: pptx, odp, pdf, txt, png, jpg, svg. Google caps exports at 10 MB.',
  inputSchema: schema(
    { fileId: FILE_ID, mimeType: s('Target MIME type, such as application/pdf or text/csv. An extension such as docx works too.') },
    ['fileId', 'mimeType'],
  ),
  annotations: READ,
  async run(args, ctx) {
    const fileId = idArg(args, 'fileId', 'file_id');
    const target = exportType(reqStr(args, 'mimeType', 'mime_type'));
    const content = await fileContent(ctx, fileId, target, true);
    const id = content.meta.id ?? fileId;
    return {
      file_id: id,
      export_mime_type: content.mimeType,
      size_bytes: content.data?.byteLength ?? null,
      file: content.data ? fileOutput(content.name, content.mimeType, content.data) : null,
      export_size_limit_exceeded: content.data === null,
      ...(content.data === null ? { export_link: content.meta.exportLinks?.[content.mimeType] ?? null, message: EXPORT_LIMIT_NOTE } : {}),
      display_url: content.meta.webViewLink ?? viewUrl(id, content.meta.mimeType),
    };
  },
};

const parseFile: GoogleTool = {
  name: 'parse_file',
  title: 'Download or export file',
  description: 'Same as download_file: stored files as they are, Google Workspace files exported to mime_type (PDF by default). Kept for Composio compatibility.',
  inputSchema: schema({ file_id: FILE_ID, mime_type: s('Export format for a Google Workspace file.') }, ['file_id']),
  annotations: READ,
  async run(args, ctx) {
    const content = await fileContent(ctx, idArg(args, 'file_id', 'fileId'), exportType(optStr(args, 'mime_type', 'mimeType')));
    if (!content.data) throw new ToolInputError(`${content.name}: ${EXPORT_LIMIT_NOTE}`);
    const id = content.meta.id ?? '';
    return { file: fileOutput(content.name, content.mimeType, content.data), display_url: content.meta.webViewLink ?? viewUrl(id, content.meta.mimeType) };
  },
};

const downloadFileRevision: GoogleTool = {
  name: 'download_file_revision',
  title: 'Download file revision',
  description:
    'Download the bytes of one revision of a stored file (PDF, image, Office) as base64. Google Workspace revisions cannot be downloaded: get_revision lists their exportLinks.',
  inputSchema: schema(
    {
      file_id: FILE_ID,
      revision_id: s('Revision id from list_revisions.'),
      file_name: s('Name for the downloaded file.'),
      acknowledge_abuse: b('Acknowledge the risk of a file Google flags as abusive.'),
    },
    ['file_id', 'revision_id'],
  ),
  annotations: READ,
  async run(args, ctx) {
    const fileId = idArg(args, 'file_id', 'fileId');
    const revisionId = reqStr(args, 'revision_id', 'revisionId');
    const path = `${filePath(fileId)}/revisions/${enc(revisionId)}`;
    const revision = await ctx.google.json<{ mimeType?: string; size?: string; originalFilename?: string }>({
      url: path,
      query: { fields: 'id,mimeType,size,originalFilename' },
    });
    const mimeType = revision?.mimeType ?? '';
    if (mimeType.startsWith(WORKSPACE)) {
      throw new ToolInputError(`Revision ${revisionId} is a ${mimeType} revision. Get its exportLinks with get_revision; Drive does not serve its bytes.`);
    }
    const size = Number(revision?.size ?? 0);
    if (size > MAX_FILE_BYTES) throw tooLarge(`Revision ${revisionId}`, size, viewUrl(fileId));
    const { data, contentType } = await ctx.google.bytes({ url: path, query: { alt: 'media', acknowledgeAbuse: flag(args, 'acknowledge_abuse', 'acknowledgeAbuse') } });
    const type = mimeType || contentType.split(';')[0]!.trim();
    const name = optStr(args, 'file_name') ?? revision?.originalFilename ?? `${fileId}-${revisionId}`;
    return { file: fileOutput(name, type, data), file_id: fileId, revision_id: revisionId, mime_type: type, size_bytes: data.byteLength };
  },
};

function downloadOperationTool(name: string, deprecated: boolean): GoogleTool {
  return {
    name,
    title: 'Start download operation',
    description:
      'Start a Drive download operation (it also covers Google Vids). The answer is a long-running operation; once `done`, `response.downloadUri` links the file for 24 hours. ' +
      `download_file returns the bytes directly.${deprecated ? ' Same as download_file_operation.' : ''}`,
    inputSchema: schema(
      deprecated
        ? { file_id: FILE_ID }
        : {
            file_id: FILE_ID,
            mime_type: s('Export format for a Google Workspace file; PDF when omitted. Ignored for stored files.'),
            revision_id: s('Revision to download; the head revision when omitted.'),
          },
      ['file_id'],
    ),
    annotations: READ,
    async run(args, ctx) {
      const meta = await fileMeta(ctx, idArg(args, 'file_id', 'fileId'));
      const id = meta.id ?? '';
      const type = meta.mimeType ?? '';
      const exportMime = type.startsWith(WORKSPACE) ? (exportType(optStr(args, 'mime_type', 'mimeType')) ?? DEFAULT_EXPORT[type]) : undefined;
      const operation = await ctx.google.json<Json>({
        method: 'POST',
        url: `${filePath(id)}/download`,
        query: { mimeType: exportMime, revisionId: optStr(args, 'revision_id', 'revisionId') },
      });
      return { ...operation, display_url: meta.webViewLink ?? viewUrl(id, type) };
    },
  };
}

// ─── Create, upload, edit, copy ─────────────────────────────────────────────

const createFolder: GoogleTool = {
  name: 'create_folder',
  title: 'Create folder',
  description:
    'Create a folder in My Drive, or inside parent_id. parent_id takes a folder id or an exact folder name (first match); the parent must exist.',
  inputSchema: schema({ name: s('Folder name.'), parent_id: s('Parent folder id, URL or exact name. Omit for My Drive.') }, ['name']),
  annotations: WRITE,
  async run(args, ctx) {
    const parent = strList(args, 'parent_id', 'parent_folder_id', 'folder_id', 'parents')[0];
    const parents = parent ? [await folderId(ctx, parent)] : undefined;
    const folder = await ctx.google.json<Json>({
      method: 'POST',
      url: `${D}/files`,
      query: { supportsAllDrives: true, fields: FILE_FIELDS },
      body: { name: reqStr(args, 'name', 'folder_name', 'title'), mimeType: FOLDER, parents },
    });
    return withLink(folder);
  },
};

const createFile: GoogleTool = {
  name: 'create_file',
  title: 'Create file',
  description:
    'Create a file or folder. With file_to_upload it uploads the bytes; without, it creates an empty file, such as a blank Google Doc ' +
    '(mimeType application/vnd.google-apps.document). A Workspace mimeType with an uploaded file converts it (docx → Google Doc). New files are private.',
  inputSchema: schema({
    name: s('File name. Defaults to the uploaded file name, or Untitled.'),
    mimeType: s('MIME type of the new file, such as application/vnd.google-apps.spreadsheet, application/vnd.google-apps.folder or text/plain.'),
    parents: strs('One parent folder id. Omit for My Drive.'),
    description: s('Short description.'),
    starred: b('Star the file.'),
    fields: FIELDS,
    file_to_upload: uploadProp('Content to upload.'),
    attachments: ATTACHMENTS,
  }),
  annotations: WRITE,
  async run(args, ctx) {
    const file = await uploadArg(args, 'file_to_upload');
    const parents = idList(args, 'parents', 'parent_id', 'folder_id');
    const metadata: Json = {
      name: optStr(args, 'name') ?? file?.filename,
      mimeType: optStr(args, 'mimeType', 'mime_type') ?? file?.mimeType,
      parents: parents.length ? parents : undefined,
      description: optStr(args, 'description'),
      starred: flag(args, 'starred'),
    };
    const fields = optStr(args, 'fields') ?? FILE_FIELDS;
    if (file) return uploadFile(ctx, { metadata, media: file, fields });
    return withLink(await ctx.google.json<Json>({ method: 'POST', url: `${D}/files`, query: { supportsAllDrives: true, fields }, body: metadata }));
  },
};

/** The text type Drive converts into each Google Workspace type. */
const TEXT_SOURCE: Record<string, string> = {
  'application/vnd.google-apps.spreadsheet': 'text/csv',
  'application/vnd.google-apps.presentation': 'text/plain',
};

const createFileFromText: GoogleTool = {
  name: 'create_file_from_text',
  title: 'Create file from text',
  description:
    'Create a file from text. mime_type sets its type: text/plain, text/markdown, text/csv, text/html, application/json, … ' +
    'application/vnd.google-apps.document makes a Google Doc (HTML keeps formatting); application/vnd.google-apps.spreadsheet makes a Sheet from CSV.',
  inputSchema: schema(
    {
      file_name: s('File name. title and name are aliases.'),
      text_content: s('The text, UTF-8. content, body and text are aliases.'),
      mime_type: s('Type of the new file; it must match the text.', { default: 'text/plain' }),
      parent_id: s('Parent folder id. Omit for My Drive. folder_id and parent_folder_id are aliases.'),
    },
    ['file_name', 'text_content'],
  ),
  annotations: WRITE,
  async run(args, ctx) {
    const name = reqStr(args, 'file_name', 'title', 'name');
    const text = [args.text_content, args.content, args.body, args.text].find((v): v is string => typeof v === 'string');
    if (text === undefined) throw new ToolInputError('text_content is required');
    const mimeType = optStr(args, 'mime_type', 'mimeType') ?? 'text/plain';
    const parent = strList(args, 'parent_id', 'folder_id', 'parent_folder_id')[0];
    const source = mimeType.startsWith(WORKSPACE) ? (TEXT_SOURCE[mimeType] ?? (/^\s*</.test(text) ? 'text/html' : 'text/plain')) : mimeType;
    return uploadFile(ctx, {
      metadata: { name, mimeType, parents: parent ? [idFrom(parent)] : undefined },
      media: { filename: name, mimeType: source, data: new TextEncoder().encode(text) },
    });
  },
};

const uploadFileTool: GoogleTool = {
  name: 'upload_file',
  title: 'Upload file',
  description: 'Upload a file (up to 25 MB) to My Drive, or into folder_to_upload_to.',
  inputSchema: schema({
    file_to_upload: uploadProp('The file.'),
    attachments: ATTACHMENTS,
    folder_to_upload_to: s('Target folder id. Omit for My Drive.'),
  }),
  annotations: WRITE,
  async run(args, ctx) {
    const file = await requireUpload(args, 'file_to_upload');
    const folder = optStr(args, 'folder_to_upload_to', 'folder_id', 'parent_id');
    return uploadFile(ctx, { metadata: { name: file.filename, mimeType: file.mimeType, parents: folder ? [idFrom(folder)] : undefined }, media: file });
  },
};

const uploadFromUrl: GoogleTool = {
  name: 'upload_from_url',
  title: 'Upload file from URL',
  description:
    'Download a public https URL (up to 25 MB) and save it to Drive. A Google Workspace mime_type converts it, such as a .docx into a Google Doc.',
  inputSchema: schema(
    {
      source_url: s('Public https URL of the file. A signed URL works.'),
      name: s('File name in Drive, with extension.'),
      mime_type: s('Type in Drive. Defaults to the download type.'),
      parent_folder_id: s('Parent folder id. Omit for My Drive.'),
    },
    ['source_url', 'name'],
  ),
  annotations: WRITE,
  async run(args, ctx) {
    const headers = optObj(args, 'source_headers');
    if (headers && Object.keys(headers).length) {
      throw new ToolInputError('source_headers is not supported: Kortix downloads public https URLs only. Pass a signed URL, or upload the bytes with upload_file.');
    }
    const name = optStr(args, 'name');
    const file = await resolveFile({ url: reqStr(args, 'source_url', 'url'), name }, 'source_url');
    const target = optStr(args, 'mime_type', 'mimeType');
    const parent = optStr(args, 'parent_folder_id', 'folder_id', 'parent_id');
    return uploadFile(ctx, {
      metadata: { name: name ?? file.filename, mimeType: target, parents: parent ? [idFrom(parent)] : undefined },
      media: { filename: file.filename, mimeType: target && !target.startsWith(WORKSPACE) ? target : file.mimeType, data: file.data },
      fields: 'kind,id,name,mimeType,size,parents,createdTime,modifiedTime,webViewLink,webContentLink',
    });
  },
};

const uploadUpdateFile: GoogleTool = {
  name: 'upload_update_file',
  title: 'Replace file content',
  description: "Replace a stored file's content with an uploaded file, keeping its id, name and sharing.",
  inputSchema: schema(
    {
      fileId: FILE_ID,
      file_to_upload: uploadProp('The new content.'),
      attachments: ATTACHMENTS,
      addParents: s('Folder ids to add, comma-separated.'),
      removeParents: s('Folder ids to remove, comma-separated.'),
      keepRevisionForever: b('Keep the new revision forever.'),
      ocrLanguage: s('OCR language hint (ISO 639-1) for images.'),
      useContentAsIndexableText: b('Index the uploaded content as text.'),
    },
    ['fileId'],
  ),
  annotations: WRITE,
  async run(args, ctx) {
    const fileId = idArg(args, 'fileId', 'file_id');
    const file = await requireUpload(args, 'file_to_upload');
    return uploadFile(ctx, {
      fileId,
      metadata: {},
      media: file,
      query: {
        addParents: optStr(args, 'addParents', 'add_parents'),
        removeParents: optStr(args, 'removeParents', 'remove_parents'),
        keepRevisionForever: flag(args, 'keepRevisionForever'),
        ocrLanguage: optStr(args, 'ocrLanguage'),
        useContentAsIndexableText: flag(args, 'useContentAsIndexableText'),
      },
    });
  },
};

const resumableUpload: GoogleTool = {
  name: 'resumable_upload',
  title: 'Upload file with metadata',
  description:
    'Upload a new file, or replace the content of file_id, with optional Drive metadata such as {name, parents, mimeType}. ' +
    'Kortix sends files up to 25 MB in one request, so sessionUri is always null.',
  inputSchema: schema(
    {
      file_to_upload: uploadProp('The file.'),
      attachments: ATTACHMENTS,
      file_id: s('Replace the content of this file instead of creating one.'),
      metadata: anyObj("Drive file metadata, such as {name, parents, description}. A Workspace mimeType converts the upload."),
      folder_to_upload_to: s('Parent folder id for a new file.'),
      queryParams: anyObj('Drive query options: ocrLanguage, keepRevisionForever, ignoreDefaultVisibility, useContentAsIndexableText, includeLabels.'),
    },
    // file_to_upload or attachments: requireUpload enforces one of them.
  ),
  annotations: WRITE,
  async run(args, ctx) {
    const file = await requireUpload(args, 'file_to_upload');
    const target = optStr(args, 'file_id', 'fileId');
    const metadata: Json = { ...(optObj(args, 'metadata') ?? {}) };
    const folder = optStr(args, 'folder_to_upload_to');
    if (!target) {
      metadata.name ??= file.filename;
      if (folder && !metadata.parents) metadata.parents = [idFrom(folder)];
    }
    const params = optObj(args, 'queryParams') ?? {};
    const result = await uploadFile(ctx, {
      fileId: target ? idFrom(target) : undefined,
      metadata,
      media: file,
      query: pick(params, ['ocrLanguage', 'includeLabels', 'keepRevisionForever', 'ignoreDefaultVisibility', 'includePermissionsForView', 'useContentAsIndexableText']),
    });
    return { file: result, sessionUri: null, display_url: result.display_url ?? null };
  },
};

const editFile: GoogleTool = {
  name: 'edit_file',
  title: 'Overwrite file with text',
  description:
    "Replace the whole content of a stored file (.txt, .md, .json, .csv, …) with text, keeping its id. Google Docs, Sheets and Slides are refused: edit them with their own tools.",
  inputSchema: schema(
    {
      file_id: FILE_ID,
      content: s('The new full content, UTF-8.'),
      mime_type: s('Type of the new content, such as text/plain or application/json.', { default: 'text/plain' }),
    },
    ['file_id', 'content'],
  ),
  annotations: WRITE,
  async run(args, ctx) {
    const fileId = idArg(args, 'file_id', 'fileId');
    const content = args.content;
    if (typeof content !== 'string') throw new ToolInputError('content is required');
    const mimeType = optStr(args, 'mime_type', 'mimeType') ?? 'text/plain';
    if (mimeType.startsWith(WORKSPACE)) throw new ToolInputError('mime_type describes the content, such as text/plain, not a Google Workspace type');
    const meta = await ctx.google.json<DriveMeta>({ url: filePath(fileId), query: { fields: 'id,name,mimeType', supportsAllDrives: true } });
    if (meta?.mimeType?.startsWith(WORKSPACE)) {
      throw new ToolInputError(`${meta.name ?? fileId} is a ${meta.mimeType} file. edit_file overwrites stored files only; use the Docs, Sheets or Slides tools.`);
    }
    return uploadFile(ctx, { fileId, metadata: {}, media: { filename: meta?.name ?? fileId, mimeType, data: new TextEncoder().encode(content) } });
  },
};

const copyFile: GoogleTool = {
  name: 'copy_file',
  title: 'Copy file',
  description: 'Copy a file (not a folder) into the same folder. new_title names the copy; the default is "Copy of …". copy_file_advanced sets more.',
  inputSchema: schema({ file_id: FILE_ID, new_title: s('Name of the copy.') }, ['file_id']),
  annotations: WRITE,
  async run(args, ctx) {
    const copy = await ctx.google.json<Json>({
      method: 'POST',
      url: `${filePath(idArg(args, 'file_id', 'fileId'))}/copy`,
      query: { supportsAllDrives: true, fields: FILE_FIELDS },
      body: { name: optStr(args, 'new_title', 'name') },
    });
    return withLink(copy);
  },
};

const COPY_BODY = ['name', 'starred', 'mimeType', 'properties', 'appProperties', 'description', 'modifiedTime', 'createdTime', 'folderColorRgb', 'writersCanShare', 'copyRequiresWriterPermission', 'trashed'];

const copyFileAdvanced: GoogleTool = {
  name: 'copy_file_advanced',
  title: 'Copy file with options',
  description: 'Copy a file and set metadata on the copy in the same call: name, parents, description, properties, a Workspace mimeType to convert, and more.',
  inputSchema: schema(
    {
      fileId: FILE_ID,
      name: s('Name of the copy. Default: "Copy of <name>".'),
      parents: strs('Folder of the copy (one id). Default: the source folder.'),
      description: s('Description of the copy.'),
      mimeType: s('Convert the copy, such as application/vnd.google-apps.document for a .docx.'),
      starred: b('Star the copy.'),
      properties: anyObj('Key-value properties visible to all apps.'),
      appProperties: anyObj('Key-value properties private to this app.'),
      writersCanShare: b('Let writers change sharing.'),
      copyRequiresWriterPermission: b('Stop readers and commenters from copying, printing or downloading.'),
      folderColorRgb: s('Folder color as #RRGGBB.'),
      modifiedTime: s('RFC 3339 modified time to set.'),
      ignoreDefaultVisibility: b("Ignore the domain's default sharing for the copy."),
      keepRevisionForever: b('Keep the new head revision forever.'),
      ocrLanguage: s('OCR language hint (ISO 639-1).'),
      includeLabels: INCLUDE_LABELS,
      includePermissionsForView: PUBLISHED_VIEW,
      fields: FIELDS,
    },
    ['fileId'],
  ),
  annotations: WRITE,
  async run(args, ctx) {
    const parents = idList(args, 'parents');
    const copy = await ctx.google.json<Json>({
      method: 'POST',
      url: `${filePath(idArg(args, 'fileId', 'file_id'))}/copy`,
      query: {
        ...pick(args, ['ignoreDefaultVisibility', 'keepRevisionForever', 'ocrLanguage', 'includeLabels', 'includePermissionsForView']),
        supportsAllDrives: true,
        fields: optStr(args, 'fields') ?? FILE_FIELDS,
      },
      body: { ...pick(args, COPY_BODY), ...(parents.length ? { parents } : {}) },
    });
    return withLink(copy);
  },
};

const createShortcut: GoogleTool = {
  name: 'create_shortcut_to_file',
  title: 'Create shortcut',
  description: 'Create a shortcut to a file or folder, so it shows in a second place without a copy. It lands in My Drive; move it with move_file.',
  inputSchema: schema(
    {
      name: s('Shortcut name.'),
      target_id: s('Id of the file or folder it points to.'),
      keepRevisionForever: b('Keep the new head revision forever.'),
      ignoreDefaultVisibility: b("Ignore the domain's default sharing."),
      includeLabels: INCLUDE_LABELS,
      includePermissionsForView: PUBLISHED_VIEW,
    },
    ['name', 'target_id'],
  ),
  annotations: WRITE,
  async run(args, ctx) {
    const parents = idList(args, 'parents', 'parent_id', 'folder_id');
    const shortcut = await ctx.google.json<Json>({
      method: 'POST',
      url: `${D}/files`,
      query: { ...pick(args, ['keepRevisionForever', 'ignoreDefaultVisibility', 'includeLabels', 'includePermissionsForView']), supportsAllDrives: true, fields: FILE_FIELDS },
      body: {
        name: reqStr(args, 'name'),
        mimeType: SHORTCUT,
        shortcutDetails: { targetId: idArg(args, 'target_id', 'targetId') },
        ...(parents.length ? { parents } : {}),
      },
    });
    return withLink(shortcut);
  },
};

// ─── Update, move, trash, delete ────────────────────────────────────────────

const updateFilePut: GoogleTool = {
  name: 'update_file_put',
  title: 'Update file metadata',
  description:
    "Change a file's name, description, star, sharing flags or folders. Only the fields you pass change. To move, pass add_parents and remove_parents together, or use move_file.",
  inputSchema: schema(
    {
      fileId: FILE_ID,
      name: s('New name.'),
      description: s('New description.'),
      starred: b('Star or unstar.'),
      mime_type: s('New MIME type (only with a new revision).'),
      add_parents: s('Folder ids to add, comma-separated.'),
      remove_parents: s('Folder ids to remove, comma-separated.'),
      writers_can_share: b('Let writers change sharing.'),
      viewers_can_copy_content: b('Let readers and commenters copy, print and download.'),
      keep_revision_forever: b('Keep the head revision forever.'),
      ocr_language: s('OCR language hint (ISO 639-1).'),
      use_domain_admin_access: DOMAIN_ADMIN,
    },
    ['fileId'],
  ),
  annotations: IDEMPOTENT,
  async run(args, ctx) {
    const fileId = idArg(args, 'fileId', 'file_id');
    const canCopy = flag(args, 'viewers_can_copy_content', 'viewersCanCopyContent');
    const file = await ctx.google.json<Json>({
      method: 'PATCH',
      url: filePath(fileId),
      query: {
        addParents: optStr(args, 'add_parents', 'addParents'),
        removeParents: optStr(args, 'remove_parents', 'removeParents'),
        keepRevisionForever: flag(args, 'keep_revision_forever', 'keepRevisionForever'),
        ocrLanguage: optStr(args, 'ocr_language', 'ocrLanguage'),
        useDomainAdminAccess: flag(args, 'use_domain_admin_access', 'useDomainAdminAccess'),
        supportsAllDrives: true,
        fields: FILE_FIELDS,
      },
      body: {
        name: optStr(args, 'name'),
        description: optStr(args, 'description'),
        starred: flag(args, 'starred'),
        mimeType: optStr(args, 'mime_type', 'mimeType'),
        writersCanShare: flag(args, 'writers_can_share', 'writersCanShare'),
        copyRequiresWriterPermission: canCopy === undefined ? undefined : !canCopy,
      },
    });
    return withLink(file, fileId);
  },
};

const UPDATE_V2_QUERY = [
  'addParents',
  'removeParents',
  'newRevision',
  'ocr',
  'ocrLanguage',
  'pinned',
  'setModifiedDate',
  'updateViewedDate',
  'timedTextLanguage',
  'timedTextTrackName',
  'useContentAsIndexableText',
  'includeLabels',
  'includePermissionsForView',
];

const updateFileMetadataPatch: GoogleTool = {
  name: 'update_file_metadata_patch',
  title: 'Update file metadata (v2)',
  description: "Change a file's metadata with Drive API v2: title, description, labels (starred, trashed, restricted), properties, folders. Only the fields you pass change.",
  inputSchema: schema(
    {
      fileId: FILE_ID,
      title: s('New title (name).'),
      description: s('New description.'),
      labels: anyObj('{starred, trashed, restricted, viewed, hidden} flags.'),
      mimeType: s('New MIME type.'),
      properties: arr(anyObj('{key, value, visibility}'), 'Custom properties to set.'),
      writersCanShare: b('Let writers change sharing.'),
      indexableText: anyObj('{text} to index for search.'),
      modifiedDate: s('RFC 3339 modified date; needs setModifiedDate.'),
      addParents: s('Folder ids to add, comma-separated.'),
      removeParents: s('Folder ids to remove, comma-separated.'),
      newRevision: b('Create a new revision.'),
      ocr: b('OCR .jpg, .png, .gif or .pdf uploads.'),
      ocrLanguage: s('OCR language hint (ISO 639-1).'),
      pinned: b('Pin the new head revision.'),
      setModifiedDate: b('Set modifiedDate to the given value.'),
      updateViewedDate: b('Update the viewed date.'),
      timedTextLanguage: s('Timed text language.'),
      timedTextTrackName: s('Timed text track name.'),
      useContentAsIndexableText: b('Index the content as text.'),
      includeLabels: INCLUDE_LABELS,
      includePermissionsForView: PUBLISHED_VIEW,
    },
    ['fileId'],
  ),
  annotations: IDEMPOTENT,
  async run(args, ctx) {
    const fileId = idArg(args, 'fileId', 'file_id');
    const file = await ctx.google.json<Json>({
      method: 'PATCH',
      url: file2Path(fileId),
      query: { ...pick(args, UPDATE_V2_QUERY), supportsAllDrives: true },
      body: pick(args, ['title', 'description', 'labels', 'mimeType', 'properties', 'writersCanShare', 'indexableText', 'modifiedDate']),
    });
    return { ...file, display_url: typeof file?.alternateLink === 'string' ? file.alternateLink : viewUrl(fileId) };
  },
};

const moveFile: GoogleTool = {
  name: 'move_file',
  title: 'Move file',
  description:
    'Move a file or folder into another folder. add_parents is the destination folder id; the current folder is removed for you. ' +
    'remove_parents alone moves a My Drive file to My Drive root. A shared-drive item needs add_parents.',
  inputSchema: schema(
    {
      file_id: FILE_ID,
      add_parents: s('Destination folder id (not a name).'),
      remove_parents: s('Folder ids to leave, comma-separated. Default: every current folder.'),
      keep_revision_forever: b('Keep the head revision forever.'),
      ocr_language: s('OCR language hint (ISO 639-1).'),
      use_content_as_indexable_text: b('Index the content as text.'),
      include_labels: INCLUDE_LABELS,
      include_permissions_for_view: PUBLISHED_VIEW,
    },
    ['file_id'],
  ),
  annotations: WRITE,
  async run(args, ctx) {
    const fileId = idArg(args, 'file_id', 'fileId');
    let add = idList(args, 'add_parents', 'addParents', 'new_parent_id', 'destination_folder_id');
    let remove = idList(args, 'remove_parents', 'removeParents');
    if (!add.length && !remove.length) throw new ToolInputError('add_parents (the destination folder id) or remove_parents is required');
    if (!add.length || !remove.length) {
      const current = await ctx.google.json<{ parents?: string[]; driveId?: string }>({ url: filePath(fileId), query: { fields: 'parents,driveId', supportsAllDrives: true } });
      const parents = current?.parents ?? [];
      if (!remove.length) {
        remove = parents.filter((p) => !add.includes(p));
      } else if (parents.every((p) => remove.includes(p))) {
        if (current?.driveId) throw new ToolInputError('A shared-drive item keeps one folder: pass add_parents with the destination folder id');
        const root = await ctx.google.json<{ id?: string }>({ url: filePath('root'), query: { fields: 'id' } });
        add = [root?.id ?? 'root'];
      }
    }
    const file = await ctx.google.json<Json>({
      method: 'PATCH',
      url: filePath(fileId),
      query: {
        addParents: add.join(',') || undefined,
        removeParents: remove.join(',') || undefined,
        keepRevisionForever: flag(args, 'keep_revision_forever', 'keepRevisionForever'),
        ocrLanguage: optStr(args, 'ocr_language', 'ocrLanguage'),
        useContentAsIndexableText: flag(args, 'use_content_as_indexable_text', 'useContentAsIndexableText'),
        includeLabels: optStr(args, 'include_labels', 'includeLabels'),
        includePermissionsForView: optStr(args, 'include_permissions_for_view', 'includePermissionsForView'),
        supportsAllDrives: true,
        fields: FILE_FIELDS,
      },
      body: {},
    });
    return withLink(file, fileId);
  },
};

function trashTool(name: string, trashed: boolean): GoogleTool {
  return {
    name,
    title: trashed ? 'Trash file' : 'Restore file from Trash',
    description: trashed
      ? 'Move a file or folder to Trash. untrash_file restores it; Drive empties Trash after 30 days.'
      : 'Restore a file or folder from Trash. A permanently deleted file cannot be restored.',
    inputSchema: schema({ file_id: FILE_ID, ...(trashed ? { fields: FIELDS } : {}) }, ['file_id']),
    annotations: trashed ? REMOVE : IDEMPOTENT,
    async run(args, ctx) {
      const fileId = idArg(args, 'file_id', 'fileId');
      const file = await ctx.google.json<Json>({
        method: 'PATCH',
        url: filePath(fileId),
        query: { supportsAllDrives: true, fields: optStr(args, 'fields') ?? FILE_FIELDS },
        body: { trashed },
      });
      return withLink(file, fileId);
    },
  };
}

function deleteFileTool(name: string, note: string): GoogleTool {
  return {
    name,
    title: 'Delete file permanently',
    description: `Delete a file or folder permanently, without Trash. A folder takes everything inside it. This cannot be undone; trash_file is the reversible way.${note}`,
    inputSchema: schema({ fileId: FILE_ID }, ['fileId']),
    annotations: REMOVE,
    async run(args, ctx) {
      const fileId = idArg(args, 'fileId', 'file_id');
      await ctx.google.json({ method: 'DELETE', url: filePath(fileId), query: { supportsAllDrives: true } });
      return { deleted: true, file_id: fileId };
    },
  };
}

const emptyTrash: GoogleTool = {
  name: 'empty_trash',
  title: 'Empty Trash',
  description:
    "Delete every item in the account's Trash permanently, or in one shared drive's Trash with driveId. Nothing can restore them. Ask the person first.",
  inputSchema: schema({ driveId: s("Empty this shared drive's Trash instead.") }),
  annotations: REMOVE,
  async run(args, ctx) {
    const driveId = optStr(args, 'driveId', 'drive_id');
    await ctx.google.json({ method: 'DELETE', url: `${D}/files/trash`, query: { driveId } });
    return { emptied: true, message: driveId ? `Emptied the Trash of shared drive ${driveId}.` : 'Emptied the Trash.' };
  },
};

// ─── v2 parents, children and properties ────────────────────────────────────

const addParent: GoogleTool = {
  name: 'add_parent',
  title: 'Add file to folder (v2)',
  description: 'Add a folder to a file\'s parents (Drive API v2). Drive now allows one parent per file: prefer move_file, or a shortcut for a second place.',
  inputSchema: schema({ fileId: FILE_ID, id: s('Folder id to add.'), enforceSingleParent: b('Deprecated by Google.') }, ['fileId', 'id']),
  annotations: WRITE,
  run: (args, ctx) =>
    ctx.google.json({
      method: 'POST',
      url: `${file2Path(idArg(args, 'fileId', 'file_id'))}/parents`,
      query: { supportsAllDrives: true, enforceSingleParent: flag(args, 'enforceSingleParent') },
      body: { id: idArg(args, 'id', 'parent_id', 'folder_id') },
    }),
};

const getParent: GoogleTool = {
  name: 'get_parent',
  title: 'Get parent reference (v2)',
  description: "One parent reference of a file (Drive API v2): whether parentId is one of the file's folders.",
  inputSchema: schema({ fileId: FILE_ID, parentId: s('Folder id.'), fields: FIELDS }, ['fileId', 'parentId']),
  annotations: READ,
  run: (args, ctx) =>
    ctx.google.json({ url: `${file2Path(idArg(args, 'fileId', 'file_id'))}/parents/${enc(idArg(args, 'parentId', 'parent_id'))}`, query: { fields: optStr(args, 'fields') } }),
};

const deleteParent: GoogleTool = {
  name: 'delete_parent',
  title: 'Remove file from folder (v2)',
  description: "Remove a folder from a file's parents (Drive API v2). A My Drive file with no parent left is hard to find: prefer move_file.",
  inputSchema: schema({ fileId: FILE_ID, parentId: s('Folder id to remove.'), enforceSingleParent: b('Deprecated by Google.') }, ['fileId', 'parentId']),
  annotations: REMOVE,
  async run(args, ctx) {
    const fileId = idArg(args, 'fileId', 'file_id');
    const parentId = idArg(args, 'parentId', 'parent_id');
    await ctx.google.json({ method: 'DELETE', url: `${file2Path(fileId)}/parents/${enc(parentId)}`, query: { enforceSingleParent: flag(args, 'enforceSingleParent') } });
    return { deleted: true, file_id: fileId, parent_id: parentId };
  },
};

const insertChild: GoogleTool = {
  name: 'insert_child',
  title: 'Put file in folder (v2)',
  description: 'Add an existing file to a folder (Drive API v2). Drive now allows one parent per file: prefer move_file.',
  inputSchema: schema({ folderId: s('Folder id.'), id: s('Id of the file to add.'), enforceSingleParent: b('Deprecated by Google.'), fields: FIELDS }, ['folderId', 'id']),
  annotations: WRITE,
  run: (args, ctx) =>
    ctx.google.json({
      method: 'POST',
      url: `${file2Path(idArg(args, 'folderId', 'folder_id'))}/children`,
      query: { supportsAllDrives: true, enforceSingleParent: flag(args, 'enforceSingleParent'), fields: optStr(args, 'fields') },
      body: { id: idArg(args, 'id', 'child_id', 'file_id') },
    }),
};

const getChild: GoogleTool = {
  name: 'get_child',
  title: 'Get child reference (v2)',
  description: 'One child reference of a folder (Drive API v2): whether childId is inside folderId.',
  inputSchema: schema({ folderId: s('Folder id.'), childId: s('File id.'), fields: FIELDS }, ['folderId', 'childId']),
  annotations: READ,
  run: (args, ctx) =>
    ctx.google.json({ url: `${file2Path(idArg(args, 'folderId', 'folder_id'))}/children/${enc(idArg(args, 'childId', 'child_id'))}`, query: { fields: optStr(args, 'fields') } }),
};

const deleteChild: GoogleTool = {
  name: 'delete_child',
  title: 'Remove file from folder (v2)',
  description: 'Remove a file from a folder (Drive API v2). The file stays in Drive. Prefer move_file.',
  inputSchema: schema({ folderId: s('Folder id.'), childId: s('File id to remove.'), enforceSingleParent: b('Deprecated by Google.') }, ['folderId', 'childId']),
  annotations: REMOVE,
  async run(args, ctx) {
    const folder = idArg(args, 'folderId', 'folder_id');
    const child = idArg(args, 'childId', 'child_id');
    await ctx.google.json({ method: 'DELETE', url: `${file2Path(folder)}/children/${enc(child)}`, query: { enforceSingleParent: flag(args, 'enforceSingleParent') } });
    return { deleted: true, folder_id: folder, child_id: child };
  },
};

const VISIBILITY = s('PRIVATE (this app only, the default) or PUBLIC (all apps).', { enum: ['PRIVATE', 'PUBLIC'] });
const propertyPath = (args: Json, key?: string) => `${file2Path(idArg(args, 'fileId', 'file_id'))}/properties${key ? `/${enc(key)}` : ''}`;

const listFileProperties: GoogleTool = {
  name: 'list_file_properties',
  title: 'List file properties (v2)',
  description: "List a file's custom key-value properties (Drive API v2).",
  inputSchema: schema({ fileId: FILE_ID, fields: FIELDS }, ['fileId']),
  annotations: READ,
  run: (args, ctx) => ctx.google.json({ url: propertyPath(args), query: { fields: optStr(args, 'fields') } }),
};

const getFileProperty: GoogleTool = {
  name: 'get_file_property',
  title: 'Get file property (v2)',
  description: 'One custom property of a file by key (Drive API v2).',
  inputSchema: schema({ fileId: FILE_ID, propertyKey: s('Property key.'), visibility: VISIBILITY }, ['fileId', 'propertyKey']),
  annotations: READ,
  run: (args, ctx) =>
    ctx.google.json({ url: propertyPath(args, reqStr(args, 'propertyKey', 'property_key')), query: { visibility: optStr(args, 'visibility') } }),
};

const addProperty: GoogleTool = {
  name: 'add_property',
  title: 'Add file property (v2)',
  description: 'Add a custom key-value property to a file, or overwrite it when the key exists (Drive API v2).',
  inputSchema: schema(
    { fileId: FILE_ID, property_key: s('Property key.'), property_value: s('Property value.'), visibility: VISIBILITY, fields: FIELDS },
    ['fileId', 'property_key', 'property_value'],
  ),
  annotations: IDEMPOTENT,
  run: (args, ctx) =>
    ctx.google.json({
      method: 'POST',
      url: propertyPath(args),
      query: { fields: optStr(args, 'fields') },
      body: { key: reqStr(args, 'property_key', 'propertyKey'), value: reqStr(args, 'property_value', 'value'), visibility: optStr(args, 'visibility') },
    }),
};

const patchProperty: GoogleTool = {
  name: 'patch_property',
  title: 'Change file property (v2)',
  description: "Change a custom property's value or visibility (Drive API v2). Only the fields you pass change.",
  inputSchema: schema(
    { fileId: FILE_ID, propertyKey: s('Property key.'), value: s('New value.'), visibility: VISIBILITY, fields: FIELDS },
    ['fileId', 'propertyKey'],
  ),
  annotations: IDEMPOTENT,
  run: (args, ctx) =>
    ctx.google.json({
      method: 'PATCH',
      url: propertyPath(args, reqStr(args, 'propertyKey', 'property_key')),
      query: { visibility: optStr(args, 'visibility'), fields: optStr(args, 'fields') },
      body: { value: optStr(args, 'value', 'property_value'), visibility: optStr(args, 'visibility') },
    }),
};

const updateFileProperty: GoogleTool = {
  name: 'update_file_property',
  title: 'Replace file property (v2)',
  description: 'Replace a custom property of a file (Drive API v2). visibility selects the property; property_visibility sets its new visibility.',
  inputSchema: schema(
    {
      fileId: FILE_ID,
      propertyKey: s('Property key.'),
      property_value: s('New value.'),
      visibility: VISIBILITY,
      property_visibility: s('New visibility: PRIVATE or PUBLIC.', { enum: ['PRIVATE', 'PUBLIC'] }),
      fields: FIELDS,
    },
    ['fileId', 'propertyKey'],
  ),
  annotations: IDEMPOTENT,
  run(args, ctx) {
    const key = reqStr(args, 'propertyKey', 'property_key');
    return ctx.google.json({
      method: 'PUT',
      url: propertyPath(args, key),
      query: { visibility: optStr(args, 'visibility'), fields: optStr(args, 'fields') },
      body: { key, value: optStr(args, 'property_value', 'value'), visibility: optStr(args, 'property_visibility', 'visibility') },
    });
  },
};

const deleteProperty: GoogleTool = {
  name: 'delete_property',
  title: 'Delete file property (v2)',
  description: 'Delete a custom property of a file (Drive API v2). visibility defaults to PRIVATE.',
  inputSchema: schema({ fileId: FILE_ID, propertyKey: s('Property key.'), visibility: VISIBILITY }, ['fileId', 'propertyKey']),
  annotations: REMOVE,
  async run(args, ctx) {
    const key = reqStr(args, 'propertyKey', 'property_key');
    await ctx.google.json({ method: 'DELETE', url: propertyPath(args, key), query: { visibility: optStr(args, 'visibility') } });
    return { deleted: true, property_key: key };
  },
};

// ─── Permissions ────────────────────────────────────────────────────────────

const permissionsPath = (fileId: string, permissionId?: string) => `${filePath(fileId)}/permissions${permissionId ? `/${enc(permissionId)}` : ''}`;

/** One new permission from Composio's snake_case arguments (camelCase works too). */
async function createPermission(ctx: ToolContext, args: Json): Promise<Json> {
  const fileId = idArg(args, 'file_id', 'fileId');
  const type = reqStr(args, 'type');
  const role = reqStr(args, 'role');
  const email = optStr(args, 'email_address', 'emailAddress', 'email');
  const domain = optStr(args, 'domain');
  if ((type === 'user' || type === 'group') && !email) throw new ToolInputError(`email_address is required when type is ${type}`);
  if (type === 'domain' && !domain) throw new ToolInputError('domain is required when type is domain');
  const permission = await ctx.google.json<Json>({
    method: 'POST',
    url: permissionsPath(fileId),
    query: {
      sendNotificationEmail: flag(args, 'send_notification_email', 'sendNotificationEmail'),
      emailMessage: optStr(args, 'email_message', 'emailMessage'),
      transferOwnership: flag(args, 'transfer_ownership', 'transferOwnership'),
      moveToNewOwnersRoot: flag(args, 'move_to_new_owners_root', 'moveToNewOwnersRoot'),
      useDomainAdminAccess: flag(args, 'use_domain_admin_access', 'useDomainAdminAccess'),
      supportsAllDrives: true,
      fields: '*',
    },
    body: {
      type,
      role,
      ...(type === 'user' || type === 'group' ? { emailAddress: email } : {}),
      ...(type === 'domain' ? { domain } : {}),
      expirationTime: optStr(args, 'expiration_time', 'expirationTime'),
      allowFileDiscovery: flag(args, 'allow_file_discovery', 'allowFileDiscovery'),
    },
  });
  return { ...permission, display_url: viewUrl(fileId) };
}

const PERMISSION_PROPS: Props = {
  file_id: s('Id of the file, folder or shared drive.'),
  type: GRANTEE,
  role: ROLE,
  email_address: s('Email of the user or group. Required for type user or group.'),
  domain: s('Domain, such as example.com. Required for type domain.'),
  transfer_ownership: b('Required to make role owner: the current owner becomes a writer.'),
};

const createPermissionTool: GoogleTool = {
  name: 'create_permission',
  title: 'Share file',
  description:
    'Share a file, folder or shared drive with a user, group, domain or anyone with the link. Google emails users and groups unless send_notification_email is false. ' +
    'type anyone with role writer exposes the file widely: confirm first.',
  inputSchema: schema(
    {
      ...PERMISSION_PROPS,
      email_message: s('Text added to the notification email.'),
      send_notification_email: b('Email the user or group (users and groups only; default true).'),
      expiration_time: s('RFC 3339 time the access ends (users and groups, at most a year ahead).'),
      allow_file_discovery: b('Let domain or anyone permissions find the file in search.'),
      move_to_new_owners_root: b("With an ownership transfer, move the file to the new owner's My Drive."),
      use_domain_admin_access: DOMAIN_ADMIN,
    },
    ['file_id', 'type', 'role'],
  ),
  annotations: WRITE,
  run: (args, ctx) => createPermission(ctx, args),
};

const addFileSharingPreference: GoogleTool = {
  name: 'add_file_sharing_preference',
  title: 'Share file (legacy)',
  description: 'Share a file with a user, group, domain or anyone. Same as create_permission, which also sets the email message and expiry.',
  inputSchema: schema(PERMISSION_PROPS, ['file_id', 'role', 'type']),
  annotations: WRITE,
  run: (args, ctx) => createPermission(ctx, args),
};

async function batchPermission(ctx: ToolContext, item: unknown, index: number): Promise<Json> {
  const contentId = String(index + 1);
  try {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new ToolInputError(`permissions[${index}] must be an object`);
    const permission = await createPermission(ctx, item as Json);
    return { content_id: contentId, success: true, status_code: 200, permission_id: permission.id ?? null, error_message: null };
  } catch (error) {
    if (error instanceof ToolInputError) return { content_id: contentId, success: false, status_code: 400, permission_id: null, error_message: error.message };
    // A rejected token is the connection's problem, not this item's: let it reach the server.
    if (error instanceof GoogleApiError && error.status !== 401) {
      return { content_id: contentId, success: false, status_code: error.status, permission_id: null, error_message: error.message };
    }
    throw error;
  }
}

const createPermissionsBatch: GoogleTool = {
  name: 'create_permissions_batch',
  title: 'Share files in bulk',
  description: 'Create up to 100 permissions, across one or many files. Each result says whether it worked; one failure does not stop the rest.',
  inputSchema: schema(
    {
      permissions: arr(
        {
          type: 'object',
          properties: {
            ...PERMISSION_PROPS,
            email_message: s('Text added to the notification email.'),
            send_notification_email: b('Email the user or group.'),
            expiration_time: s('RFC 3339 time the access ends.'),
            allow_file_discovery: b('Let the file be found in search.'),
          },
          required: ['file_id', 'type', 'role'],
        },
        'Permissions to create, 1–100.',
      ),
    },
    ['permissions'],
  ),
  annotations: WRITE,
  async run(args, ctx) {
    const items = arrayArg(args, 'permissions') ?? [];
    if (!items.length) throw new ToolInputError('permissions is required: 1–100 items of {file_id, type, role, …}');
    if (items.length > 100) throw new ToolInputError('permissions takes at most 100 items');
    const byFile = new Map<string, number[]>();
    items.forEach((item, index) => {
      const record = item && typeof item === 'object' ? (item as Json) : {};
      const key = String(record.file_id ?? record.fileId ?? '');
      byFile.set(key, [...(byFile.get(key) ?? []), index]);
    });
    const results = new Array<Json>(items.length);
    // Drive keeps only the last of concurrent permission changes on one file: one file's items run in order.
    await mapLimit([...byFile.values()], 4, async (indexes) => {
      for (const index of indexes) results[index] = await batchPermission(ctx, items[index], index);
    });
    const ok = results.filter((r) => r.success === true).length;
    return { results, total_requested: items.length, total_successful: ok, total_failed: items.length - ok };
  },
};

const listPermissions: GoogleTool = {
  name: 'list_permissions',
  title: 'List sharing permissions',
  description: 'List who has access to a file, folder or shared drive, with each permission id (for delete_permission and update_permission). Page with pageToken.',
  inputSchema: schema(
    {
      fileId: s('Id of the file, folder or shared drive.'),
      fields: s('Fields, such as `nextPageToken,permissions(id,type,role,emailAddress)`. Default: Google\'s basic fields.'),
      pageSize: pageSize(100),
      pageToken: PAGE_TOKEN,
      useDomainAdminAccess: DOMAIN_ADMIN,
      includePermissionsForView: PUBLISHED_VIEW,
    },
    ['fileId'],
  ),
  annotations: READ,
  run: (args, ctx) =>
    ctx.google.json({
      url: permissionsPath(idArg(args, 'fileId', 'file_id')),
      query: {
        fields: optStr(args, 'fields'),
        pageSize: int(args, ['pageSize', 'page_size'], undefined, 100),
        pageToken: pageToken(args),
        useDomainAdminAccess: flag(args, 'useDomainAdminAccess', 'use_domain_admin_access'),
        includePermissionsForView: optStr(args, 'includePermissionsForView', 'include_permissions_for_view'),
        supportsAllDrives: true,
      },
    }),
};

const getPermission: GoogleTool = {
  name: 'get_permission',
  title: 'Get permission',
  description: 'One permission of a file or shared drive by id.',
  inputSchema: schema(
    { file_id: s('Id of the file, folder or shared drive.'), permission_id: s('Permission id from list_permissions.'), fields: FIELDS, use_domain_admin_access: DOMAIN_ADMIN },
    ['file_id', 'permission_id'],
  ),
  annotations: READ,
  run: (args, ctx) =>
    ctx.google.json({
      url: permissionsPath(idArg(args, 'file_id', 'fileId'), reqStr(args, 'permission_id', 'permissionId')),
      query: { fields: optStr(args, 'fields'), useDomainAdminAccess: flag(args, 'use_domain_admin_access', 'useDomainAdminAccess'), supportsAllDrives: true },
    }),
};

const updatePermission: GoogleTool = {
  name: 'update_permission',
  title: 'Change permission',
  description: "Change a permission's role or expiry. Inherited and domain-managed permissions may refuse changes.",
  inputSchema: schema(
    {
      fileId: s('Id of the file, folder or shared drive.'),
      permissionId: s('Permission id from list_permissions.'),
      permission: {
        type: 'object',
        properties: { role: ROLE, expirationTime: s('RFC 3339 time the access ends (users and groups only).') },
        description: 'The change: {role} and/or {expirationTime}.',
      },
      removeExpiration: b('Remove the expiry.', { default: false }),
      transferOwnership: b('Required to make role owner.', { default: false }),
      useDomainAdminAccess: { ...DOMAIN_ADMIN, default: false },
      enforceExpansiveAccess: b("Apply the role to the item's children too (Google's expansive access).", { default: false }),
    },
    ['fileId', 'permissionId', 'permission'],
  ),
  annotations: IDEMPOTENT,
  run(args, ctx) {
    const change = optObj(args, 'permission') ?? pick(args, ['role', 'expirationTime']);
    if (!Object.keys(change).length) throw new ToolInputError('permission is required: {role} and/or {expirationTime}');
    return ctx.google.json({
      method: 'PATCH',
      url: permissionsPath(idArg(args, 'fileId', 'file_id'), reqStr(args, 'permissionId', 'permission_id')),
      query: {
        removeExpiration: flag(args, 'removeExpiration', 'remove_expiration'),
        transferOwnership: flag(args, 'transferOwnership', 'transfer_ownership'),
        useDomainAdminAccess: flag(args, 'useDomainAdminAccess', 'use_domain_admin_access'),
        enforceExpansiveAccess: flag(args, 'enforceExpansiveAccess'),
        supportsAllDrives: true,
        fields: '*',
      },
      body: pick(change, ['role', 'expirationTime']),
    });
  },
};

const patchPermission: GoogleTool = {
  name: 'patch_permission',
  title: 'Change permission (v2)',
  description: "Change a permission's role, link sharing or expiry with Drive API v2. For commenter, pass role reader and additional_roles [\"commenter\"].",
  inputSchema: schema(
    {
      file_id: FILE_ID,
      permission_id: s('Permission id from list_permissions.'),
      role: s('owner, organizer, fileOrganizer, writer or reader.', { enum: ['owner', 'organizer', 'fileOrganizer', 'writer', 'reader'] }),
      additional_roles: strs('Extra roles, such as ["commenter"].'),
      with_link: b('Access only through the link (type anyone or domain).'),
      expiration_date: s('RFC 3339 time the access ends.'),
      remove_expiration: b('Remove the expiry.'),
      transfer_ownership: b('Required to make role owner.'),
      use_domain_admin_access: DOMAIN_ADMIN,
    },
    ['file_id', 'permission_id'],
  ),
  annotations: IDEMPOTENT,
  run(args, ctx) {
    const extra = strList(args, 'additional_roles', 'additionalRoles');
    return ctx.google.json({
      method: 'PATCH',
      url: `${file2Path(idArg(args, 'file_id', 'fileId'))}/permissions/${enc(reqStr(args, 'permission_id', 'permissionId'))}`,
      query: {
        removeExpiration: flag(args, 'remove_expiration', 'removeExpiration'),
        transferOwnership: flag(args, 'transfer_ownership', 'transferOwnership'),
        useDomainAdminAccess: flag(args, 'use_domain_admin_access', 'useDomainAdminAccess'),
        supportsAllDrives: true,
      },
      body: {
        role: optStr(args, 'role'),
        additionalRoles: extra.length ? extra : undefined,
        withLink: flag(args, 'with_link', 'withLink'),
        expirationDate: optStr(args, 'expiration_date', 'expirationDate'),
      },
    });
  },
};

const deletePermission: GoogleTool = {
  name: 'delete_permission',
  title: 'Remove sharing permission',
  description:
    "Remove one person's, group's, domain's or link's access by permission id (from list_permissions). The owner cannot be removed: that answers success false.",
  inputSchema: schema(
    { file_id: s('Id of the file, folder or shared drive.'), permission_id: s('Permission id from list_permissions, such as anyoneWithLink.'), useDomainAdminAccess: DOMAIN_ADMIN },
    ['file_id', 'permission_id'],
  ),
  annotations: REMOVE,
  async run(args, ctx) {
    const fileId = idArg(args, 'file_id', 'fileId');
    const permissionId = reqStr(args, 'permission_id', 'permissionId');
    try {
      await ctx.google.json({
        method: 'DELETE',
        url: permissionsPath(fileId, permissionId),
        query: { useDomainAdminAccess: flag(args, 'useDomainAdminAccess', 'use_domain_admin_access'), supportsAllDrives: true },
      });
    } catch (error) {
      if (error instanceof GoogleApiError && error.status === 403 && (error.reason === 'cannotRemoveOwner' || /\bowner\b/i.test(error.message))) {
        return { success: false, file_id: fileId, permission_id: permissionId, message: error.message, display_url: viewUrl(fileId) };
      }
      throw error;
    }
    return { success: true, file_id: fileId, permission_id: permissionId, display_url: viewUrl(fileId) };
  },
};

const getPermissionIdForEmail: GoogleTool = {
  name: 'get_permission_id_for_email',
  title: 'Get permission id for email',
  description: 'The permission id Drive uses for an email address (Drive API v2). list_permissions shows the ids already on a file.',
  inputSchema: schema({ email: s('Email address.'), fields: FIELDS }, ['email']),
  annotations: READ,
  run: (args, ctx) =>
    ctx.google.json({ url: `${D2}/permissionIds/${enc(reqStr(args, 'email', 'email_address'))}`, query: { fields: optStr(args, 'fields') } }),
};

function proposalList(name: string, title: string, path: string, description: string): GoogleTool {
  return {
    name,
    title,
    description,
    inputSchema: schema({ fileId: FILE_ID, pageSize: pageSize(100), pageToken: PAGE_TOKEN }, ['fileId']),
    annotations: READ,
    run: (args, ctx) =>
      ctx.google.json({
        url: `${filePath(idArg(args, 'fileId', 'file_id'))}/${path}`,
        query: { pageSize: int(args, ['pageSize', 'page_size'], undefined, 100), pageToken: pageToken(args) },
      }),
  };
}

// ─── Comments and replies ───────────────────────────────────────────────────

const commentPath = (fileId: string, commentId?: string) => `${filePath(fileId)}/comments${commentId ? `/${enc(commentId)}` : ''}`;
const replyPath = (fileId: string, commentId: string, replyId?: string) => `${commentPath(fileId, commentId)}/replies${replyId ? `/${enc(replyId)}` : ''}`;
const COMMENT_FIELDS = s('Fields to return. Default `*` (Drive requires a selection for comments).', { default: '*' });

const listComments: GoogleTool = {
  name: 'list_comments',
  title: 'List comments',
  description: 'List the comments on a file, with their replies. Page with pageToken.',
  inputSchema: schema(
    {
      fileId: FILE_ID,
      pageSize: pageSize(100, 20),
      pageToken: PAGE_TOKEN,
      includeDeleted: b('Include deleted comments.', { default: false }),
      startModifiedTime: s('Only comments modified after this RFC 3339 time.'),
      fields: COMMENT_FIELDS,
    },
    ['fileId'],
  ),
  annotations: READ,
  run: (args, ctx) =>
    ctx.google.json({
      url: commentPath(idArg(args, 'fileId', 'file_id')),
      query: {
        fields: optStr(args, 'fields') ?? '*',
        pageSize: int(args, ['pageSize', 'page_size'], 20, 100),
        pageToken: pageToken(args),
        includeDeleted: flag(args, 'includeDeleted', 'include_deleted'),
        startModifiedTime: optStr(args, 'startModifiedTime', 'start_modified_time'),
      },
    }),
};

const getComment: GoogleTool = {
  name: 'get_comment',
  title: 'Get comment',
  description: 'One comment on a file, with its replies.',
  inputSchema: schema({ fileId: FILE_ID, commentId: s('Comment id.'), includeDeleted: b('Return it even when deleted.') }, ['fileId', 'commentId']),
  annotations: READ,
  run: (args, ctx) =>
    ctx.google.json({
      url: commentPath(idArg(args, 'fileId', 'file_id'), reqStr(args, 'commentId', 'comment_id')),
      query: { fields: '*', includeDeleted: flag(args, 'includeDeleted', 'include_deleted') },
    }),
};

const createComment: GoogleTool = {
  name: 'create_comment',
  title: 'Add comment',
  description: 'Add a comment to a file. Omit anchor and the quoted fields for a comment on the whole file.',
  inputSchema: schema(
    {
      file_id: FILE_ID,
      content: s('Comment text.'),
      anchor: s('JSON region the comment is anchored to, such as {"region": {"kind": "drive#commentRegion", "line": 12, "rev": "head"}}.'),
      quoted_file_content_value: s('The text the comment quotes.'),
      quoted_file_content_mime_type: s('MIME type of the quoted text, such as text/plain.'),
    },
    ['file_id', 'content'],
  ),
  annotations: WRITE,
  run(args, ctx) {
    const raw = args.anchor;
    const anchor = typeof raw === 'string' ? raw : raw && typeof raw === 'object' ? JSON.stringify(raw) : undefined;
    const quoted = optStr(args, 'quoted_file_content_value');
    return ctx.google.json({
      method: 'POST',
      url: commentPath(idArg(args, 'file_id', 'fileId')),
      query: { fields: '*' },
      body: {
        content: reqStr(args, 'content'),
        anchor,
        ...(quoted ? { quotedFileContent: { value: quoted, mimeType: optStr(args, 'quoted_file_content_mime_type') ?? 'text/plain' } } : {}),
      },
    });
  },
};

const updateComment: GoogleTool = {
  name: 'update_comment',
  title: 'Edit comment',
  description: "Change a comment's text. resolved true or false resolves or reopens it (Kortix posts the resolve reply for you).",
  inputSchema: schema(
    { file_id: FILE_ID, comment_id: s('Comment id.'), content: s('New text.'), resolved: b('Resolve (true) or reopen (false).'), fields: COMMENT_FIELDS },
    ['file_id', 'comment_id'],
  ),
  annotations: IDEMPOTENT,
  async run(args, ctx) {
    const path = commentPath(idArg(args, 'file_id', 'fileId'), reqStr(args, 'comment_id', 'commentId'));
    const fields = optStr(args, 'fields') ?? '*';
    const content = optStr(args, 'content');
    const resolved = flag(args, 'resolved');
    if (content === undefined && resolved === undefined) throw new ToolInputError('content or resolved is required');
    let comment: Json | null = null;
    if (content !== undefined) comment = await ctx.google.json<Json>({ method: 'PATCH', url: path, query: { fields }, body: { content } });
    if (resolved !== undefined) {
      await ctx.google.json({ method: 'POST', url: `${path}/replies`, query: { fields: 'id' }, body: { action: resolved ? 'resolve' : 'reopen' } });
      comment = await ctx.google.json<Json>({ url: path, query: { fields } });
    }
    return comment;
  },
};

const deleteComment: GoogleTool = {
  name: 'delete_comment',
  title: 'Delete comment',
  description: 'Delete a comment and all its replies. This cannot be undone; delete_reply removes one reply.',
  inputSchema: schema({ file_id: FILE_ID, comment_id: s('Comment id.') }, ['file_id', 'comment_id']),
  annotations: REMOVE,
  async run(args, ctx) {
    const commentId = reqStr(args, 'comment_id', 'commentId');
    await ctx.google.json({ method: 'DELETE', url: commentPath(idArg(args, 'file_id', 'fileId'), commentId) });
    return { deleted: true, comment_id: commentId, message: 'Comment deleted.' };
  },
};

const listReplies: GoogleTool = {
  name: 'list_replies',
  title: 'List replies',
  description: 'List the replies to a comment. Page with page_token.',
  inputSchema: schema(
    {
      file_id: FILE_ID,
      comment_id: s('Comment id.'),
      page_size: pageSize(100),
      page_token: PAGE_TOKEN,
      include_deleted: b('Include deleted replies.', { default: false }),
      fields: COMMENT_FIELDS,
    },
    ['file_id', 'comment_id'],
  ),
  annotations: READ,
  run: (args, ctx) =>
    ctx.google.json({
      url: replyPath(idArg(args, 'file_id', 'fileId'), reqStr(args, 'comment_id', 'commentId')),
      query: {
        fields: optStr(args, 'fields') ?? '*',
        pageSize: int(args, ['page_size', 'pageSize'], undefined, 100),
        pageToken: pageToken(args),
        includeDeleted: flag(args, 'include_deleted', 'includeDeleted'),
      },
    }),
};

const getReply: GoogleTool = {
  name: 'get_reply',
  title: 'Get reply',
  description: 'One reply to a comment.',
  inputSchema: schema(
    { fileId: FILE_ID, commentId: s('Comment id.'), replyId: s('Reply id.'), includeDeleted: b('Return it even when deleted.') },
    ['fileId', 'commentId', 'replyId'],
  ),
  annotations: READ,
  run: (args, ctx) =>
    ctx.google.json({
      url: replyPath(idArg(args, 'fileId', 'file_id'), reqStr(args, 'commentId', 'comment_id'), reqStr(args, 'replyId', 'reply_id')),
      query: { fields: '*', includeDeleted: flag(args, 'includeDeleted', 'include_deleted') },
    }),
};

const createReply: GoogleTool = {
  name: 'create_reply',
  title: 'Reply to comment',
  description: 'Reply to a comment. action resolve or reopen also resolves or reopens it.',
  inputSchema: schema(
    {
      file_id: FILE_ID,
      comment_id: s('Comment id.'),
      content: s('Reply text.'),
      action: s('resolve or reopen.', { enum: ['resolve', 'reopen'] }),
      fields: COMMENT_FIELDS,
    },
    ['file_id', 'comment_id', 'content'],
  ),
  annotations: WRITE,
  run(args, ctx) {
    const content = optStr(args, 'content');
    const action = optStr(args, 'action');
    if (!content && !action) throw new ToolInputError('content is required');
    return ctx.google.json({
      method: 'POST',
      url: replyPath(idArg(args, 'file_id', 'fileId'), reqStr(args, 'comment_id', 'commentId')),
      query: { fields: optStr(args, 'fields') ?? '*' },
      body: { content, action },
    });
  },
};

const updateReply: GoogleTool = {
  name: 'update_reply',
  title: 'Edit reply',
  description: "Change a reply's text.",
  inputSchema: schema(
    { file_id: FILE_ID, comment_id: s('Comment id.'), reply_id: s('Reply id.'), content: s('New text.'), fields: COMMENT_FIELDS },
    ['file_id', 'comment_id', 'reply_id', 'content'],
  ),
  annotations: IDEMPOTENT,
  run: (args, ctx) =>
    ctx.google.json({
      method: 'PATCH',
      url: replyPath(idArg(args, 'file_id', 'fileId'), reqStr(args, 'comment_id', 'commentId'), reqStr(args, 'reply_id', 'replyId')),
      query: { fields: optStr(args, 'fields') ?? '*' },
      body: { content: reqStr(args, 'content') },
    }),
};

const deleteReply: GoogleTool = {
  name: 'delete_reply',
  title: 'Delete reply',
  description: 'Delete one reply to a comment. The comment and other replies stay. This cannot be undone.',
  inputSchema: schema({ file_id: FILE_ID, comment_id: s('Comment id.'), reply_id: s('Reply id.') }, ['file_id', 'comment_id', 'reply_id']),
  annotations: REMOVE,
  async run(args, ctx) {
    const replyId = reqStr(args, 'reply_id', 'replyId');
    try {
      await ctx.google.json({ method: 'DELETE', url: replyPath(idArg(args, 'file_id', 'fileId'), reqStr(args, 'comment_id', 'commentId'), replyId) });
    } catch (error) {
      if (error instanceof GoogleApiError && error.status === 404) return { deleted: true, already_deleted: true, reply_id: replyId, message: 'The reply was already gone.' };
      throw error;
    }
    return { deleted: true, already_deleted: false, reply_id: replyId, message: 'Reply deleted.' };
  },
};

// ─── Revisions ──────────────────────────────────────────────────────────────

const revisionPath = (args: Json) => `${filePath(idArg(args, 'file_id', 'fileId'))}/revisions/${enc(reqStr(args, 'revision_id', 'revisionId'))}`;

const listRevisions: GoogleTool = {
  name: 'list_revisions',
  title: 'List revisions',
  description: "List a file's revisions (metadata only). Drive prunes old revisions of busy files, so the list can be incomplete.",
  inputSchema: schema({ fileId: FILE_ID, pageSize: pageSize(1000), pageToken: PAGE_TOKEN }, ['fileId']),
  annotations: READ,
  run: (args, ctx) =>
    ctx.google.json({
      url: `${filePath(idArg(args, 'fileId', 'file_id'))}/revisions`,
      query: { fields: '*', pageSize: int(args, ['pageSize', 'page_size'], undefined, 1000), pageToken: pageToken(args) },
    }),
};

const getRevision: GoogleTool = {
  name: 'get_revision',
  title: 'Get revision',
  description: "One revision's metadata: time, author, size, keepForever and, for Google Workspace files, exportLinks. download_file_revision returns a stored file's bytes.",
  inputSchema: schema(
    { file_id: FILE_ID, revision_id: s('Revision id from list_revisions.'), acknowledge_abuse: b('Acknowledge the risk of a file Google flags as abusive.') },
    ['file_id', 'revision_id'],
  ),
  annotations: READ,
  run: (args, ctx) => ctx.google.json({ url: revisionPath(args), query: { fields: '*', acknowledgeAbuse: flag(args, 'acknowledge_abuse', 'acknowledgeAbuse') } }),
};

const updateRevision: GoogleTool = {
  name: 'update_file_revision_metadata',
  title: 'Update revision settings',
  description: "Change a revision's keepForever and publishing settings. It does not change content: edit_file and upload_update_file do.",
  inputSchema: schema(
    {
      file_id: FILE_ID,
      revision_id: s('Revision id from list_revisions.'),
      keepForever: b('Keep this revision forever (stored files; at most 200 per file).'),
      published: b('Publish this revision (Docs, Sheets, Slides).'),
      publishAuto: b('Publish later revisions automatically.'),
      publishedOutsideDomain: b('Publish outside the domain.'),
    },
    ['file_id', 'revision_id'],
  ),
  annotations: IDEMPOTENT,
  run(args, ctx) {
    const body = {
      keepForever: flag(args, 'keepForever', 'keep_forever'),
      published: flag(args, 'published'),
      publishAuto: flag(args, 'publishAuto', 'publish_auto'),
      publishedOutsideDomain: flag(args, 'publishedOutsideDomain', 'published_outside_domain'),
    };
    if (Object.values(body).every((v) => v === undefined)) throw new ToolInputError('Pass keepForever, published, publishAuto or publishedOutsideDomain');
    return ctx.google.json({ method: 'PATCH', url: revisionPath(args), query: { fields: '*' }, body });
  },
};

const deleteRevision: GoogleTool = {
  name: 'delete_revision',
  title: 'Delete revision',
  description: 'Delete one revision of a stored file (image, PDF, …) permanently. Google Workspace revisions and the last revision cannot be deleted.',
  inputSchema: schema({ file_id: FILE_ID, revision_id: s('Revision id from list_revisions.') }, ['file_id', 'revision_id']),
  annotations: REMOVE,
  async run(args, ctx) {
    await ctx.google.json({ method: 'DELETE', url: revisionPath(args) });
    return { success: true, revision_id: reqStr(args, 'revision_id', 'revisionId'), message: 'Revision deleted.' };
  },
};

// ─── Shared drives and Team Drives ──────────────────────────────────────────

const DRIVE_LOOKS: Props = {
  themeId: s('Theme id from get_about driveThemes. Do not combine with colorRgb or backgroundImageFile.'),
  colorRgb: s('Color as #RRGGBB.'),
  backgroundImageFile: anyObj('{id, xCoordinate, yCoordinate, width} of a Drive image.'),
};

function driveBody(args: Json): Json {
  return {
    ...pick(args, ['name', 'themeId', 'colorRgb']),
    ...(optObj(args, 'backgroundImageFile') ? { backgroundImageFile: optObj(args, 'backgroundImageFile') } : {}),
    ...(optObj(args, 'restrictions') ? { restrictions: optObj(args, 'restrictions') } : {}),
  };
}

function listDrivesTool(name: string, kind: 'drives' | 'teamdrives'): GoogleTool {
  return {
    name,
    title: kind === 'drives' ? 'List shared drives' : 'List Team Drives',
    description:
      kind === 'drives'
        ? 'List the shared drives the account can see. q filters, such as `name contains \'Finance\'`. Page with pageToken.'
        : 'List shared drives through the legacy Team Drives API. list_shared_drives is the current tool.',
    inputSchema: schema({
      q: s("Drive query, such as `name contains 'Finance'`."),
      pageSize: pageSize(100),
      pageToken: PAGE_TOKEN,
      useDomainAdminAccess: DOMAIN_ADMIN,
      fields: FIELDS,
    }),
    annotations: READ,
    run: (args, ctx) =>
      ctx.google.json({
        url: `${D}/${kind}`,
        query: {
          q: optStr(args, 'q', 'query'),
          pageSize: int(args, ['pageSize', 'page_size'], undefined, 100),
          pageToken: pageToken(args),
          useDomainAdminAccess: flag(args, 'useDomainAdminAccess', 'use_domain_admin_access'),
          fields: optStr(args, 'fields'),
        },
      }),
  };
}

function getDriveTool(name: string, kind: 'drives' | 'teamdrives', idKey: string, adminKey: string): GoogleTool {
  return {
    name,
    title: kind === 'drives' ? 'Get shared drive' : 'Get Team Drive',
    description: kind === 'drives' ? 'One shared drive: name, theme, capabilities and restrictions.' : 'One shared drive through the legacy Team Drives API. get_drive is the current tool.',
    inputSchema: schema({ [idKey]: s('Shared drive id.'), [adminKey]: DOMAIN_ADMIN }, [idKey]),
    annotations: READ,
    async run(args, ctx) {
      const driveId = idArg(args, idKey, 'drive_id', 'driveId', 'teamDriveId');
      const drive = await ctx.google.json<Json>({ url: `${D}/${kind}/${enc(driveId)}`, query: { useDomainAdminAccess: flag(args, adminKey, 'useDomainAdminAccess', 'use_domain_admin_access') } });
      return driveLink(drive);
    },
  };
}

function createDriveTool(name: string, kind: 'drives' | 'teamdrives'): GoogleTool {
  const shared = kind === 'drives';
  return {
    name,
    title: shared ? 'Create shared drive' : 'Create Team Drive',
    description: shared
      ? 'Create a shared drive. requestId makes a retry return the same drive; Kortix generates one when omitted.'
      : 'Create a shared drive through the legacy Team Drives API. create_drive is the current tool.',
    inputSchema: schema(
      { name: s('Drive name.'), requestId: s('Idempotency key, such as a UUID.'), ...DRIVE_LOOKS, ...(shared ? { hidden: b('Hide it from the default view.', { default: false }) } : {}) },
      ['name'],
    ),
    annotations: WRITE,
    async run(args, ctx) {
      reqStr(args, 'name');
      const drive = await ctx.google.json<Json>({ method: 'POST', url: `${D}/${kind}`, query: { requestId: optStr(args, 'requestId', 'request_id') ?? randomUUID() }, body: driveBody(args) });
      if (shared && flag(args, 'hidden') === true && typeof drive?.id === 'string') {
        return driveLink(await ctx.google.json<Json>({ method: 'POST', url: `${D}/drives/${enc(drive.id)}/hide` }));
      }
      return driveLink(drive);
    },
  };
}

function updateDriveTool(name: string, kind: 'drives' | 'teamdrives', idKey: string): GoogleTool {
  const shared = kind === 'drives';
  return {
    name,
    title: shared ? 'Update shared drive' : 'Update Team Drive',
    description: shared
      ? "Change a shared drive's name, theme, color, background or restrictions; hidden hides or shows it."
      : 'Change a shared drive through the legacy Team Drives API. update_drive is the current tool.',
    inputSchema: schema(
      {
        [idKey]: s('Shared drive id.'),
        name: s('New name.'),
        ...DRIVE_LOOKS,
        restrictions: anyObj('{adminManagedRestrictions, copyRequiresWriterPermission, domainUsersOnly, driveMembersOnly, …}.'),
        ...(shared ? { hidden: b('Hide (true) or show (false) the drive.') } : {}),
        useDomainAdminAccess: DOMAIN_ADMIN,
      },
      [idKey],
    ),
    annotations: IDEMPOTENT,
    async run(args, ctx) {
      const driveId = idArg(args, idKey, 'driveId', 'drive_id', 'teamDriveId');
      const body = driveBody(args);
      const hidden = shared ? flag(args, 'hidden') : undefined;
      if (!Object.keys(body).length && hidden === undefined) throw new ToolInputError('Nothing to change: pass name, themeId, colorRgb, backgroundImageFile, restrictions or hidden');
      let drive: Json | null = null;
      if (Object.keys(body).length) {
        drive = await ctx.google.json<Json>({
          method: 'PATCH',
          url: `${D}/${kind}/${enc(driveId)}`,
          query: { useDomainAdminAccess: flag(args, 'useDomainAdminAccess', 'use_domain_admin_access') },
          body,
        });
      }
      if (hidden !== undefined) drive = await ctx.google.json<Json>({ method: 'POST', url: `${D}/drives/${enc(driveId)}/${hidden ? 'hide' : 'unhide'}` });
      return driveLink(drive);
    },
  };
}

function deleteDriveTool(name: string, kind: 'drives' | 'teamdrives', idKey: string): GoogleTool {
  const shared = kind === 'drives';
  return {
    name,
    title: shared ? 'Delete shared drive' : 'Delete Team Drive',
    description: shared
      ? 'Delete a shared drive permanently. It must be empty unless allowItemDeletion (domain administrators only) deletes its items too.'
      : 'Delete an empty shared drive through the legacy Team Drives API. delete_drive is the current tool.',
    inputSchema: schema(
      shared
        ? { [idKey]: s('Shared drive id.'), allowItemDeletion: b('Delete its items too (needs useDomainAdminAccess).'), useDomainAdminAccess: DOMAIN_ADMIN }
        : { [idKey]: s('Shared drive id.') },
      [idKey],
    ),
    annotations: REMOVE,
    async run(args, ctx) {
      const driveId = idArg(args, idKey, 'driveId', 'drive_id', 'teamDriveId');
      await ctx.google.json({
        method: 'DELETE',
        url: `${D}/${kind}/${enc(driveId)}`,
        query: shared ? { allowItemDeletion: flag(args, 'allowItemDeletion'), useDomainAdminAccess: flag(args, 'useDomainAdminAccess', 'use_domain_admin_access') } : {},
      });
      return { deleted: true, drive_id: driveId };
    },
  };
}

function hideDriveTool(name: string, idKey: string, hidden: boolean): GoogleTool {
  return {
    name,
    title: hidden ? 'Hide shared drive' : 'Show shared drive',
    description: hidden ? 'Hide a shared drive from the default Drive view. It is not deleted.' : 'Show a hidden shared drive in the default Drive view again.',
    inputSchema: schema({ [idKey]: s('Shared drive id.') }, [idKey]),
    annotations: IDEMPOTENT,
    async run(args, ctx) {
      const driveId = idArg(args, idKey, 'drive_id', 'driveId');
      return driveLink(await ctx.google.json<Json>({ method: 'POST', url: `${D}/drives/${enc(driveId)}/${hidden ? 'hide' : 'unhide'}` }));
    },
  };
}

// ─── Changes and push notifications ─────────────────────────────────────────

async function startPageToken(ctx: ToolContext, driveId: string | undefined): Promise<string> {
  const token = await ctx.google.json<{ startPageToken?: string }>({ url: `${D}/changes/startPageToken`, query: { driveId, supportsAllDrives: true } });
  if (!token?.startPageToken) throw new ToolInputError('Google returned no start page token');
  return token.startPageToken;
}

const getStartPageToken: GoogleTool = {
  name: 'get_changes_start_page_token',
  title: 'Get changes start token',
  description: 'A token for list_changes that marks "now": later changes are listed from it. Keep it; it only looks forward.',
  inputSchema: schema({ driveId: s("Track this shared drive's changes instead of the user's.") }),
  annotations: READ,
  run: (args, ctx) =>
    ctx.google.json({ url: `${D}/changes/startPageToken`, query: { driveId: optStr(args, 'driveId', 'drive_id', 'teamDriveId'), supportsAllDrives: true } }),
};

const listChanges: GoogleTool = {
  name: 'list_changes',
  title: 'List changes',
  description:
    'List changes to files since pageToken (from get_changes_start_page_token or newStartPageToken). Without pageToken it starts now, so it lists nothing older. ' +
    'Follow nextPageToken; keep newStartPageToken for the next poll.',
  inputSchema: schema({
    pageToken: PAGE_TOKEN,
    driveId: s("This shared drive's changes."),
    pageSize: pageSize(1000, 100),
    includeRemoved: b('Include removals (deleted, or access lost).', { default: true }),
    includeCorpusRemovals: b('Include the file when it was removed from the list but is still readable.'),
    restrictToMyDrive: b('Only changes inside My Drive.'),
    includeItemsFromAllDrives: b('Include shared drive items.', { default: true }),
    spaces: s('drive or appDataFolder.', { default: 'drive' }),
    includeLabels: INCLUDE_LABELS,
    includePermissionsForView: PUBLISHED_VIEW,
    fields: s('Fields, such as `nextPageToken,newStartPageToken,changes(fileId,removed,file(id,name,mimeType))`.'),
  }),
  annotations: READ,
  async run(args, ctx) {
    const driveId = optStr(args, 'driveId', 'drive_id');
    const token = pageToken(args) ?? (await startPageToken(ctx, driveId));
    const includeCorpusRemovals = flag(args, 'includeCorpusRemovals', 'include_corpus_removals');
    return ctx.google.json({
      url: `${D}/changes`,
      query: {
        pageToken: token,
        driveId,
        pageSize: int(args, ['pageSize', 'page_size'], 100, 1000),
        includeRemoved: includeCorpusRemovals || (flag(args, 'includeRemoved', 'include_removed') ?? true),
        includeCorpusRemovals,
        restrictToMyDrive: flag(args, 'restrictToMyDrive', 'restrict_to_my_drive'),
        includeItemsFromAllDrives: Boolean(driveId) || (flag(args, 'includeItemsFromAllDrives', 'include_items_from_all_drives') ?? true),
        supportsAllDrives: true,
        spaces: optStr(args, 'spaces'),
        includeLabels: optStr(args, 'includeLabels', 'include_labels'),
        includePermissionsForView: optStr(args, 'includePermissionsForView', 'include_permissions_for_view'),
        fields: optStr(args, 'fields'),
      },
    });
  },
};

const getChange: GoogleTool = {
  name: 'get_change',
  title: 'Get change (v2)',
  description: 'One change by id (Drive API v2). list_changes is the current way to read changes.',
  inputSchema: schema({ changeId: s('Change id.'), driveId: s('Shared drive of the change.'), fields: FIELDS }, ['changeId']),
  annotations: READ,
  run: (args, ctx) =>
    ctx.google.json({
      url: `${D2}/changes/${enc(reqStr(args, 'changeId', 'change_id'))}`,
      query: { driveId: optStr(args, 'driveId', 'drive_id', 'teamDriveId'), supportsAllDrives: true, fields: optStr(args, 'fields') },
    }),
};

const CHANNEL_PROPS: Props = {
  id: s('Your unique channel id, such as a UUID.'),
  type: s('web_hook.', { enum: ['web_hook', 'webhook'] }),
  address: s('Public https URL that receives the notifications.'),
  token: s('Text sent back with every notification, to verify it.'),
  expiration: i('Expiry, Unix time in milliseconds.'),
  params: anyObj('Channel options, such as {"ttl": "3600"}.'),
};

function channelBody(args: Json): Json {
  const type = optStr(args, 'type', 'channelType') ?? 'web_hook';
  return {
    id: reqStr(args, 'id'),
    type: type === 'webhook' ? 'web_hook' : type,
    address: reqStr(args, 'address'),
    token: optStr(args, 'token'),
    expiration: optStr(args, 'expiration'),
    params: optObj(args, 'params'),
    payload: flag(args, 'payload'),
  };
}

const watchChanges: GoogleTool = {
  name: 'watch_changes',
  title: 'Watch Drive changes',
  description:
    'Ask Google to POST a notification to address whenever files change. A notification carries no change list: call list_changes from your last token. Stop it with stop_watch_channel.',
  inputSchema: schema(
    {
      ...CHANNEL_PROPS,
      page_token: s('Change token to watch from. Default: now.'),
      drive_id: s("Watch this shared drive's changes."),
      page_size: pageSize(1000, 100),
      include_removed: b('Include removals.', { default: true }),
      include_corpus_removals: b('Include the file of a removal when still readable.'),
      restrict_to_my_drive: b('Only changes inside My Drive.', { default: false }),
      include_items_from_all_drives: b('Include shared drive items.'),
      spaces: s('drive or appDataFolder.', { default: 'drive' }),
      include_labels: INCLUDE_LABELS,
      include_permissions_for_view: PUBLISHED_VIEW,
    },
    ['id', 'type', 'address'],
  ),
  annotations: WRITE,
  async run(args, ctx) {
    const driveId = optStr(args, 'drive_id', 'driveId');
    const token = pageToken(args) ?? (await startPageToken(ctx, driveId));
    return ctx.google.json({
      method: 'POST',
      url: `${D}/changes/watch`,
      query: {
        pageToken: token,
        driveId,
        pageSize: int(args, ['page_size', 'pageSize'], 100, 1000),
        includeRemoved: flag(args, 'include_removed', 'includeRemoved') ?? true,
        includeCorpusRemovals: flag(args, 'include_corpus_removals', 'includeCorpusRemovals'),
        restrictToMyDrive: flag(args, 'restrict_to_my_drive', 'restrictToMyDrive'),
        includeItemsFromAllDrives: Boolean(driveId) || (flag(args, 'include_items_from_all_drives', 'includeItemsFromAllDrives') ?? true),
        supportsAllDrives: true,
        spaces: optStr(args, 'spaces'),
        includeLabels: optStr(args, 'include_labels', 'includeLabels'),
        includePermissionsForView: optStr(args, 'include_permissions_for_view', 'includePermissionsForView'),
      },
      body: channelBody(args),
    });
  },
};

const watchFile: GoogleTool = {
  name: 'watch_file',
  title: 'Watch file',
  description: 'Ask Google to POST a notification to address whenever one file changes. Stop it with stop_watch_channel; keep id and resourceId from the answer.',
  inputSchema: schema(
    {
      fileId: FILE_ID,
      ...CHANNEL_PROPS,
      payload: b('Include a payload in notifications.'),
      acknowledgeAbuse: b('Acknowledge the risk of a file Google flags as abusive.'),
      includeLabels: INCLUDE_LABELS,
      includePermissionsForView: PUBLISHED_VIEW,
    },
    ['fileId', 'id', 'type', 'address'],
  ),
  annotations: WRITE,
  run: (args, ctx) =>
    ctx.google.json({
      method: 'POST',
      url: `${filePath(idArg(args, 'fileId', 'file_id'))}/watch`,
      query: { ...pick(args, ['acknowledgeAbuse', 'includeLabels', 'includePermissionsForView']), supportsAllDrives: true },
      body: channelBody(args),
    }),
};

const stopWatchChannel: GoogleTool = {
  name: 'stop_watch_channel',
  title: 'Stop watch channel',
  description: 'Stop the notifications of a watch_changes or watch_file channel. Needs both id and resourceId from the watch answer.',
  inputSchema: schema(
    {
      id: s('Channel id.'),
      resourceId: s('resourceId from the watch answer.'),
      token: s('The channel token, if it had one.'),
      address: s('The channel address.'),
      channelType: s('web_hook.', { enum: ['web_hook', 'webhook'] }),
      resourceUri: s('resourceUri from the watch answer.'),
    },
    ['id', 'resourceId'],
  ),
  annotations: DESTRUCTIVE,
  async run(args, ctx) {
    const type = optStr(args, 'channelType', 'type');
    await ctx.google.json({
      method: 'POST',
      url: `${D}/channels/stop`,
      body: {
        id: reqStr(args, 'id'),
        resourceId: reqStr(args, 'resourceId', 'resource_id'),
        ...pick(args, ['token', 'address', 'resourceUri', 'kind', 'expiration', 'params', 'payload']),
        ...(type ? { type: type === 'webhook' ? 'web_hook' : type } : {}),
      },
    });
    return { stopped: true, message: 'Channel stopped.' };
  },
};

// ─── Labels ─────────────────────────────────────────────────────────────────

const listFileLabels: GoogleTool = {
  name: 'list_file_labels',
  title: 'List file labels',
  description: 'List the Drive labels applied to a file, with their field values. An empty list is normal.',
  inputSchema: schema({ file_id: FILE_ID, max_results: i('Labels per page, up to 100.'), page_token: PAGE_TOKEN }, ['file_id']),
  annotations: READ,
  run: (args, ctx) =>
    ctx.google.json({
      url: `${filePath(idArg(args, 'file_id', 'fileId'))}/listLabels`,
      query: { maxResults: int(args, ['max_results', 'maxResults', 'page_size', 'pageSize'], undefined, 100), pageToken: pageToken(args) },
    }),
};

const modifyFileLabels: GoogleTool = {
  name: 'modify_file_labels',
  title: 'Change file labels',
  description: "Apply, change or remove Drive labels on a file. Use label and field ids (list_label_definitions, list_file_labels), not names.",
  inputSchema: schema(
    {
      file_id: FILE_ID,
      label_modifications: arr(
        anyObj('{labelId, removeLabel, fieldModifications: [{fieldId, setTextValues | setSelectionValues | setDateValues | setIntegerValues | setUserValues | unsetValues}]}.'),
        'Label changes.',
      ),
    },
    ['file_id', 'label_modifications'],
  ),
  annotations: WRITE,
  async run(args, ctx) {
    const changes = arrayArg(args, 'label_modifications') ?? arrayArg(args, 'labelModifications');
    if (!changes?.length) throw new ToolInputError('label_modifications is required');
    const result = await ctx.google.json<{ modifiedLabels?: unknown[] }>({
      method: 'POST',
      url: `${filePath(idArg(args, 'file_id', 'fileId'))}/modifyLabels`,
      body: { kind: 'drive#modifyLabelsRequest', labelModifications: changes },
    });
    return { kind: 'drive#modifyLabelsResponse', modified_labels: result?.modifiedLabels ?? [] };
  },
};

const listLabelDefinitions: GoogleTool = {
  name: 'list_label_definitions',
  title: 'List label definitions',
  description: 'List the Drive labels the account can see, with each id and title.',
  inputSchema: schema({
    page_size: pageSize(200, 10),
    page_token: PAGE_TOKEN,
    published_only: b('Only published labels.'),
    minimum_role: s('Only labels where the user has at least this role.', { enum: ['LABEL_ROLE_UNSPECIFIED', 'READER', 'APPLIER', 'ORGANIZER', 'EDITOR'] }),
    language_code: s('BCP-47 language of the titles.'),
    customer: s('Workspace customer, such as customers/my_customer.'),
  }),
  annotations: READ,
  async run(args, ctx) {
    const result = await ctx.google.json<{ labels?: Array<{ id?: string; properties?: { title?: string } }>; nextPageToken?: string }>({
      url: LABELS,
      query: {
        view: 'LABEL_VIEW_BASIC',
        pageSize: int(args, ['page_size', 'pageSize'], 10, 200),
        pageToken: pageToken(args),
        publishedOnly: flag(args, 'published_only', 'publishedOnly'),
        minimumRole: optStr(args, 'minimum_role', 'minimumRole'),
        languageCode: optStr(args, 'language_code', 'languageCode'),
        customer: optStr(args, 'customer'),
      },
    });
    return {
      labels: (result?.labels ?? []).map((label) => ({ id: label.id ?? '', display_name: label.properties?.title ?? null })),
      next_page_token: result?.nextPageToken ?? null,
    };
  },
};

// ─── Sheets, Docs, Slides, Forms ────────────────────────────────────────────

const SHEET_ID = s('Spreadsheet id. A Sheets URL works too.');
const VALUE_RENDER = s('FORMATTED_VALUE (as shown), UNFORMATTED_VALUE or FORMULA.', { enum: ['FORMATTED_VALUE', 'UNFORMATTED_VALUE', 'FORMULA'] });
const DATE_RENDER = s('SERIAL_NUMBER or FORMATTED_STRING.', { enum: ['SERIAL_NUMBER', 'FORMATTED_STRING'] });
const MAJOR = s('ROWS (each inner array is a row) or COLUMNS.', { enum: ['ROWS', 'COLUMNS'] });
const INPUT_OPTION = s('USER_ENTERED parses values as if typed (formulas, dates); RAW stores them as is.', { enum: ['RAW', 'USER_ENTERED'] });
const VALUES = arr({ type: 'array', items: {} }, 'Rows of cell values, such as [["Name", "Score"], ["Ada", 95]]. null skips a cell; "" clears it.');

const sheetPath = (args: Json) => `${SHEETS}/${enc(idArg(args, 'spreadsheet_id', 'spreadsheetId'))}`;

function rangesArg(args: Json): string[] {
  const value = args.ranges ?? args.range;
  if (Array.isArray(value)) return value.filter((r): r is string => typeof r === 'string' && r.trim() !== '');
  return typeof value === 'string' && value.trim() ? [value.trim()] : [];
}

function valuesArg(args: Json, key = 'values'): unknown[][] {
  const values = arrayArg(args, key);
  if (!values?.length || !values.every(Array.isArray)) throw new ToolInputError(`${key} must be a non-empty array of rows, such as [["Name", "Score"], ["Ada", 95]]`);
  return values as unknown[][];
}

const getSpreadsheet: GoogleTool = {
  name: 'get_spreadsheet',
  title: 'Get spreadsheet',
  description: "A spreadsheet's properties and sheets (titles, ids, sizes). include_grid_data adds cell data for ranges; it can be large.",
  inputSchema: schema(
    {
      spreadsheet_id: SHEET_ID,
      ranges: strs('A1 ranges to include, such as ["Sheet1!A1:D10"].'),
      include_grid_data: b('Include cell data.', { default: false }),
      exclude_tables_in_banded_ranges: b('Leave table banding out of bandedRanges.', { default: false }),
      fields: FIELDS,
    },
    ['spreadsheet_id'],
  ),
  annotations: READ,
  run: (args, ctx) =>
    ctx.google.json({
      url: sheetPath(args),
      query: {
        ranges: rangesArg(args),
        includeGridData: flag(args, 'include_grid_data', 'includeGridData') ?? false,
        excludeTablesInBandedRanges: flag(args, 'exclude_tables_in_banded_ranges', 'excludeTablesInBandedRanges'),
        fields: optStr(args, 'fields'),
      },
    }),
};

const getSpreadsheetValues: GoogleTool = {
  name: 'get_spreadsheet_values',
  title: 'Read sheet range',
  description: 'Read the values of one range, such as `Sheet1!A1:D20` or `Sheet1`.',
  inputSchema: schema(
    {
      spreadsheet_id: SHEET_ID,
      range: s('A1 range, such as Sheet1!A1:D20.'),
      major_dimension: MAJOR,
      value_render_option: { ...VALUE_RENDER, default: 'FORMATTED_VALUE' },
      date_time_render_option: { ...DATE_RENDER, default: 'SERIAL_NUMBER' },
    },
    ['spreadsheet_id', 'range'],
  ),
  annotations: READ,
  run: (args, ctx) =>
    ctx.google.json({
      url: `${sheetPath(args)}/values/${enc(reqStr(args, 'range'))}`,
      query: {
        majorDimension: optStr(args, 'major_dimension', 'majorDimension'),
        valueRenderOption: optStr(args, 'value_render_option', 'valueRenderOption') ?? 'FORMATTED_VALUE',
        dateTimeRenderOption: optStr(args, 'date_time_render_option', 'dateTimeRenderOption') ?? 'SERIAL_NUMBER',
      },
    }),
};

function batchGetTool(name: string, title: string, defaults: boolean): GoogleTool {
  return {
    name,
    title,
    description: 'Read the values of several ranges of one spreadsheet in one call.',
    inputSchema: schema(
      {
        spreadsheet_id: SHEET_ID,
        ranges: strs('A1 ranges, such as ["Sheet1!A1:B10", "Summary"].'),
        major_dimension: MAJOR,
        value_render_option: defaults ? { ...VALUE_RENDER, default: 'FORMATTED_VALUE' } : VALUE_RENDER,
        date_time_render_option: defaults ? { ...DATE_RENDER, default: 'SERIAL_NUMBER' } : DATE_RENDER,
      },
      ['spreadsheet_id', 'ranges'],
    ),
    annotations: READ,
    run(args, ctx) {
      const ranges = rangesArg(args);
      if (!ranges.length) throw new ToolInputError('ranges is required');
      return ctx.google.json({
        url: `${sheetPath(args)}/values:batchGet`,
        query: {
          ranges,
          majorDimension: optStr(args, 'major_dimension', 'majorDimension'),
          valueRenderOption: optStr(args, 'value_render_option', 'valueRenderOption') ?? (defaults ? 'FORMATTED_VALUE' : undefined),
          dateTimeRenderOption: optStr(args, 'date_time_render_option', 'dateTimeRenderOption') ?? (defaults ? 'SERIAL_NUMBER' : undefined),
        },
      });
    },
  };
}

function writeValuesTool(name: string, majorDefault: string | undefined): GoogleTool {
  return {
    name,
    title: 'Write sheet range',
    description: 'Write rows of values into one range, replacing what is there. USER_ENTERED makes "=SUM(A1:A3)" a formula.',
    inputSchema: schema(
      {
        spreadsheet_id: SHEET_ID,
        range: s('A1 range, such as Sheet1!A1 or Sheet1!A1:C3.'),
        values: VALUES,
        value_input_option: INPUT_OPTION,
        major_dimension: majorDefault ? { ...MAJOR, default: majorDefault } : MAJOR,
        include_values_in_response: b('Return the written values.', { default: false }),
        response_value_render_option: VALUE_RENDER,
        response_date_time_render_option: DATE_RENDER,
      },
      ['spreadsheet_id', 'range', 'values', 'value_input_option'],
    ),
    annotations: IDEMPOTENT,
    run(args, ctx) {
      const range = reqStr(args, 'range');
      return ctx.google.json({
        method: 'PUT',
        url: `${sheetPath(args)}/values/${enc(range)}`,
        query: {
          valueInputOption: reqStr(args, 'value_input_option', 'valueInputOption'),
          includeValuesInResponse: flag(args, 'include_values_in_response', 'includeValuesInResponse'),
          responseValueRenderOption: optStr(args, 'response_value_render_option'),
          responseDateTimeRenderOption: optStr(args, 'response_date_time_render_option'),
        },
        body: { range, majorDimension: optStr(args, 'major_dimension', 'majorDimension') ?? majorDefault, values: valuesArg(args) },
      });
    },
  };
}

const batchUpdateValues: GoogleTool = {
  name: 'batch_update_spreadsheet_values',
  title: 'Write several sheet ranges',
  description: 'Write values into several ranges of one spreadsheet in one call.',
  inputSchema: schema(
    {
      spreadsheet_id: SHEET_ID,
      data: arr(
        { type: 'object', properties: { range: s('A1 range.'), values: VALUES, major_dimension: { ...MAJOR, default: 'ROWS' } }, required: ['range', 'values'] },
        'Ranges and their values.',
      ),
      value_input_option: INPUT_OPTION,
      include_values_in_response: b('Return the written values.', { default: false }),
      response_value_render_option: VALUE_RENDER,
      response_date_time_render_option: DATE_RENDER,
    },
    ['spreadsheet_id', 'value_input_option', 'data'],
  ),
  annotations: IDEMPOTENT,
  run(args, ctx) {
    const data = (arrayArg(args, 'data') ?? []).map((item, index) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new ToolInputError(`data[${index}] must be {range, values}`);
      const entry = item as Json;
      return {
        range: reqStr(entry, 'range'),
        values: valuesArg(entry),
        majorDimension: optStr(entry, 'major_dimension', 'majorDimension') ?? 'ROWS',
      };
    });
    if (!data.length) throw new ToolInputError('data is required: [{range, values}]');
    return ctx.google.json({
      method: 'POST',
      url: `${sheetPath(args)}/values:batchUpdate`,
      body: {
        valueInputOption: reqStr(args, 'value_input_option', 'valueInputOption'),
        data,
        includeValuesInResponse: flag(args, 'include_values_in_response', 'includeValuesInResponse'),
        responseValueRenderOption: optStr(args, 'response_value_render_option'),
        responseDateTimeRenderOption: optStr(args, 'response_date_time_render_option'),
      },
    });
  },
};

const clearValues: GoogleTool = {
  name: 'clear_spreadsheet_values',
  title: 'Clear sheet range',
  description: 'Clear the values of one range. Formatting, notes and validation stay. This cannot be undone here.',
  inputSchema: schema({ spreadsheet_id: SHEET_ID, range: s('A1 range, such as Sheet1!A2:D100.') }, ['spreadsheet_id', 'range']),
  annotations: REMOVE,
  run: (args, ctx) => ctx.google.json({ method: 'POST', url: `${sheetPath(args)}/values/${enc(reqStr(args, 'range'))}:clear`, body: {} }),
};

const getDocument: GoogleTool = {
  name: 'get_document',
  title: 'Get Google Doc',
  description: "A Google Doc's full structure: body, headers, footers, styles. include_tabs_content returns every tab. download_file with mime_type text/markdown is lighter for reading.",
  inputSchema: schema(
    {
      document_id: s('Google Doc id. A Docs URL works too.'),
      include_tabs_content: b('Return every tab under tabs.', { default: false }),
      suggestions_view_mode: s('How suggestions show.', {
        enum: ['DEFAULT_FOR_CURRENT_ACCESS', 'SUGGESTIONS_INLINE', 'PREVIEW_SUGGESTIONS_ACCEPTED', 'PREVIEW_WITHOUT_SUGGESTIONS'],
      }),
    },
    ['document_id'],
  ),
  annotations: READ,
  run: (args, ctx) =>
    ctx.google.json({
      url: `${DOCS}/${enc(idArg(args, 'document_id', 'documentId'))}`,
      query: {
        includeTabsContent: flag(args, 'include_tabs_content', 'includeTabsContent') ?? false,
        suggestionsViewMode: optStr(args, 'suggestions_view_mode', 'suggestionsViewMode'),
      },
    }),
};

const getPresentation: GoogleTool = {
  name: 'get_presentation',
  title: 'Get Google Slides presentation',
  description: 'A presentation with its slides, layouts and masters. fields narrows a large answer, such as `slides(objectId),title`.',
  inputSchema: schema({ presentation_id: s('Presentation id. A Slides URL works too.'), fields: FIELDS }, ['presentation_id']),
  annotations: READ,
  run: (args, ctx) =>
    ctx.google.json({ url: `${SLIDES}/${enc(idArg(args, 'presentation_id', 'presentationId'))}`, query: { fields: optStr(args, 'fields') } }),
};

const getPageThumbnail: GoogleTool = {
  name: 'get_presentation_page_thumbnail',
  title: 'Get slide thumbnail',
  description: 'A short-lived image URL of one slide. Google counts it as an expensive read.',
  inputSchema: schema(
    {
      presentation_id: s('Presentation id.'),
      page_object_id: s('Slide objectId from get_presentation.'),
      mime_type: s('PNG.', { default: 'PNG' }),
      thumbnail_size: s('LARGE, MEDIUM or SMALL.', { enum: ['LARGE', 'MEDIUM', 'SMALL'], default: 'LARGE' }),
    },
    ['presentation_id', 'page_object_id'],
  ),
  annotations: READ,
  run: (args, ctx) =>
    ctx.google.json({
      url: `${SLIDES}/${enc(idArg(args, 'presentation_id', 'presentationId'))}/pages/${enc(reqStr(args, 'page_object_id', 'pageObjectId'))}/thumbnail`,
      query: {
        'thumbnailProperties.mimeType': optStr(args, 'mime_type') ?? 'PNG',
        'thumbnailProperties.thumbnailSize': optStr(args, 'thumbnail_size') ?? 'LARGE',
      },
    }),
};

const getForm: GoogleTool = {
  name: 'get_form',
  title: 'Get Google Form',
  description: "A Google Form's questions, settings and publish state.",
  inputSchema: schema({ form_id: s('Form id. A Forms edit URL works too.') }, ['form_id']),
  annotations: READ,
  run: (args, ctx) => ctx.google.json({ url: `${FORMS}/${enc(idArg(args, 'form_id', 'formId'))}` }),
};

const listFormResponses: GoogleTool = {
  name: 'list_form_responses',
  title: 'List form responses',
  description: 'List the submissions of a Google Form. filter takes `timestamp > 2024-01-01T00:00:00Z`. Page with page_token.',
  inputSchema: schema(
    { form_id: s('Form id.'), filter: s('Such as timestamp > 2024-01-01T00:00:00Z.'), page_size: pageSize(5000), page_token: PAGE_TOKEN },
    ['form_id'],
  ),
  annotations: READ,
  run: (args, ctx) =>
    ctx.google.json({
      url: `${FORMS}/${enc(idArg(args, 'form_id', 'formId'))}/responses`,
      query: { filter: optStr(args, 'filter'), pageSize: int(args, ['page_size', 'pageSize'], undefined, 5000), pageToken: pageToken(args) },
    }),
};

export const DRIVE_TOOLS: readonly GoogleTool[] = [
  // Search and read
  findFile,
  findFolder,
  listFilesTool,
  listChildrenV2,
  getAbout,
  getFileMetadata,
  getFileV2,
  downloadFile,
  exportWorkspaceFile,
  parseFile,
  downloadFileRevision,
  downloadOperationTool('download_file_operation', false),
  downloadOperationTool('download_file2', true),
  // Create, upload, edit, copy
  createFolder,
  createFile,
  createFileFromText,
  uploadFileTool,
  uploadFromUrl,
  uploadUpdateFile,
  resumableUpload,
  editFile,
  copyFile,
  copyFileAdvanced,
  createShortcut,
  generateIds,
  // Update, move, trash, delete
  updateFilePut,
  updateFileMetadataPatch,
  moveFile,
  trashTool('trash_file', true),
  trashTool('untrash_file', false),
  deleteFileTool('google_drive_delete_folder_or_file_action', ''),
  deleteFileTool('delete_file', ' Same as google_drive_delete_folder_or_file_action.'),
  emptyTrash,
  // v2 parents, children, properties
  addParent,
  getParent,
  deleteParent,
  insertChild,
  getChild,
  deleteChild,
  listFileProperties,
  getFileProperty,
  addProperty,
  patchProperty,
  updateFileProperty,
  deleteProperty,
  // Sharing
  listPermissions,
  getPermission,
  createPermissionTool,
  addFileSharingPreference,
  createPermissionsBatch,
  updatePermission,
  patchPermission,
  deletePermission,
  getPermissionIdForEmail,
  proposalList('list_access_proposals', 'List access requests', 'accessproposals', 'List pending requests for access to a file. Only people who can approve them may list them.'),
  proposalList('list_approvals', 'List approvals', 'approvals', 'List the approvals on a file. Page with pageToken.'),
  // Comments and revisions
  listComments,
  getComment,
  createComment,
  updateComment,
  deleteComment,
  listReplies,
  getReply,
  createReply,
  updateReply,
  deleteReply,
  listRevisions,
  getRevision,
  updateRevision,
  deleteRevision,
  // Shared drives and Team Drives
  listDrivesTool('list_shared_drives', 'drives'),
  getDriveTool('get_drive', 'drives', 'drive_id', 'use_domain_admin_access'),
  createDriveTool('create_drive', 'drives'),
  updateDriveTool('update_drive', 'drives', 'driveId'),
  deleteDriveTool('delete_drive', 'drives', 'driveId'),
  hideDriveTool('hide_drive', 'drive_id', true),
  hideDriveTool('unhide_drive', 'driveId', false),
  listDrivesTool('list_team_drives', 'teamdrives'),
  getDriveTool('get_team_drive', 'teamdrives', 'teamDriveId', 'useDomainAdminAccess'),
  createDriveTool('create_team_drive', 'teamdrives'),
  updateDriveTool('update_team_drive', 'teamdrives', 'teamDriveId'),
  deleteDriveTool('delete_team_drive', 'teamdrives', 'teamDriveId'),
  // Changes and notifications
  getStartPageToken,
  listChanges,
  getChange,
  watchChanges,
  watchFile,
  stopWatchChannel,
  // Labels and apps
  listFileLabels,
  modifyFileLabels,
  listLabelDefinitions,
  getApp,
  // Sheets, Docs, Slides, Forms
  getSpreadsheet,
  getSpreadsheetValues,
  batchGetTool('batch_get_spreadsheet_values', 'Read several sheet ranges', true),
  batchGetTool('read_spreadsheet_values', 'Read sheet ranges', false),
  writeValuesTool('update_spreadsheet_values', 'ROWS'),
  writeValuesTool('write_spreadsheet_values', undefined),
  batchUpdateValues,
  clearValues,
  getDocument,
  getPresentation,
  getPageThumbnail,
  getForm,
  listFormResponses,
];
