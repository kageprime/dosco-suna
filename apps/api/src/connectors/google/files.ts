/**
 * File inputs and outputs of the Google tools.
 *
 * Input: a tool's `attachments` items (and Composio's `attachment`) carry the
 * bytes one of two ways:
 *   - `content`: base64. A Kortix attachment reference
 *     (`{"$kortix_attachment": "<id>"}`, `kortix connectors call --attach`)
 *     becomes this base64 before the call reaches the tool;
 *   - `url`: a public https URL Kortix downloads (the egress guard refuses
 *     private addresses).
 * Composio's `s3key` names a file in Composio's storage, which Kortix cannot
 * read: it is refused with the two ways that work.
 *
 * Output: a downloaded file comes back as `content_base64`. Save a large one
 * with `kortix connectors call … --out result.json`, then decode it.
 */
import { safeEgressFetch } from '../../shared/ssrf-guard';
import { ToolInputError, s } from './tool';

/** Gmail caps a message at 25 MB; Drive simple uploads at 5 MB, resumable beyond. */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;

export interface FileInput {
  filename: string;
  mimeType: string;
  data: Uint8Array;
}

/** The item schema of an `attachments` array. `filename` + `content` match the gateway's attachment profile. */
export const FILE_ITEM_SCHEMA = {
  type: 'object',
  properties: {
    filename: s('File name, such as report.pdf.'),
    content: s('The file as base64, or a Kortix attachment reference {"$kortix_attachment": "<id>"}.'),
    content_type: s('MIME type, such as application/pdf. Guessed from the file name when omitted.'),
    url: s('A public https URL Kortix downloads instead of `content`.'),
  },
};

const EXTENSION_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  html: 'text/html',
  json: 'application/json',
  zip: 'application/zip',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
};

export function guessMimeType(filename: string): string {
  const extension = filename.split('.').pop()?.toLowerCase() ?? '';
  return EXTENSION_TYPES[extension] ?? 'application/octet-stream';
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

async function download(url: string): Promise<{ data: Uint8Array; contentType: string | null }> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ToolInputError(`url is not a valid URL: ${url.slice(0, 200)}`);
  }
  if (parsed.protocol !== 'https:') throw new ToolInputError('url must be an https URL');
  let response: Response;
  try {
    response = await safeEgressFetch(parsed.href, { method: 'GET' });
  } catch (error) {
    throw new ToolInputError(`Kortix could not download ${parsed.origin}${parsed.pathname}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new ToolInputError(`Downloading ${parsed.origin}${parsed.pathname} answered HTTP ${response.status}`);
  }
  const length = Number(response.headers.get('content-length'));
  if (length > MAX_FILE_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw new ToolInputError(`The file at url is ${length} bytes; the limit is ${MAX_FILE_BYTES}`);
  }
  const data = new Uint8Array(await response.arrayBuffer());
  if (data.byteLength > MAX_FILE_BYTES) throw new ToolInputError(`The file at url is larger than ${MAX_FILE_BYTES} bytes`);
  return { data, contentType: response.headers.get('content-type')?.split(';')[0]?.trim() || null };
}

/** One attachment item → its bytes. `where` names the field in errors. */
export async function resolveFile(item: unknown, where: string): Promise<FileInput> {
  if (!item || typeof item !== 'object' || Array.isArray(item)) throw new ToolInputError(`${where} must be an object`);
  const record = item as Record<string, unknown>;
  const url = str(record.url) ?? str(record.s3url);
  const content = str(record.content) ?? str(record.content_base64) ?? str(record.data);
  let filename = str(record.filename) ?? str(record.name) ?? str(record.file_name);
  let mimeType = str(record.content_type) ?? str(record.mimetype) ?? str(record.mime_type) ?? str(record.mimeType);
  let data: Uint8Array;
  if (content) {
    const clean = content.replace(/^data:[^;,]+;base64,/, '').replace(/\s+/g, '');
    if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(clean)) throw new ToolInputError(`${where}.content must be base64`);
    data = new Uint8Array(Buffer.from(clean.replace(/-/g, '+').replace(/_/g, '/'), 'base64'));
  } else if (url) {
    const downloaded = await download(url);
    data = downloaded.data;
    mimeType ??= downloaded.contentType ?? undefined;
    filename ??= decodeURIComponent(new URL(url).pathname.split('/').pop() || '') || undefined;
  } else if (str(record.s3key)) {
    throw new ToolInputError(
      `${where}.s3key is a Composio file reference, which Kortix cannot read. Pass the file as \`content\` (base64, or {"$kortix_attachment": "<id>"} from \`kortix connectors upload\`) or as a public https \`url\`.`,
    );
  } else {
    throw new ToolInputError(`${where} needs \`content\` (base64) or \`url\``);
  }
  if (data.byteLength > MAX_FILE_BYTES) throw new ToolInputError(`${where} is ${data.byteLength} bytes; the limit is ${MAX_FILE_BYTES}`);
  filename ??= 'attachment';
  return { filename, mimeType: mimeType ?? guessMimeType(filename), data };
}

/** Every file of `attachments` and Composio's `attachment` (one object or a list). */
export async function resolveFiles(args: Record<string, unknown>): Promise<FileInput[]> {
  const items: Array<{ item: unknown; where: string }> = [];
  for (const key of ['attachments', 'attachment']) {
    const value = args[key];
    if (value === undefined || value === null || value === '') continue;
    const list = Array.isArray(value) ? value : [value];
    list.forEach((item, index) => items.push({ item, where: Array.isArray(value) ? `${key}[${index}]` : key }));
  }
  const files: FileInput[] = [];
  let total = 0;
  for (const { item, where } of items) {
    const file = await resolveFile(item, where);
    total += file.data.byteLength;
    if (total > MAX_FILE_BYTES) throw new ToolInputError(`The attachments total more than ${MAX_FILE_BYTES} bytes`);
    files.push(file);
  }
  return files;
}

/** A downloaded file in a tool answer. */
export function fileOutput(filename: string, mimeType: string, data: Uint8Array): Record<string, unknown> {
  return {
    name: filename,
    mimetype: mimeType,
    size: data.byteLength,
    content_base64: Buffer.from(data).toString('base64'),
  };
}
