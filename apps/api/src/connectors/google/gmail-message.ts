/**
 * Gmail API message → the `MessageBody` shape Composio's Gmail tools returned
 * (`messageId`, `threadId`, `sender`, `subject`, `messageText`,
 * `attachmentList`, …). Agents and skills written against Composio read these
 * fields, so they are kept exactly.
 */

export interface GmailPart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: Array<{ name?: string; value?: string }>;
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: GmailPart[];
}

export interface GmailMessage {
  id?: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  historyId?: string;
  internalDate?: string;
  sizeEstimate?: number;
  raw?: string;
  payload?: GmailPart;
}

export interface MessageAttachment {
  filename: string;
  mimeType: string;
  attachmentId: string;
  size: number;
  partId: string | null;
}

export interface MessageBody {
  messageId: string;
  threadId: string;
  labelIds: string[];
  subject: string;
  sender: string;
  to: string;
  cc?: string;
  bcc?: string;
  messageTimestamp: string;
  messageText: string;
  preview: { subject: string; body: string };
  attachmentList: MessageAttachment[];
  display_url: string;
  payload?: GmailPart;
}

export function decodeBase64Url(data: string): Uint8Array {
  return new Uint8Array(Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64'));
}

export function encodeBase64Url(data: Uint8Array | string): string {
  return Buffer.from(data).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function header(part: GmailPart | undefined, name: string): string {
  const lower = name.toLowerCase();
  return part?.headers?.find((h) => h.name?.toLowerCase() === lower)?.value ?? '';
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** Applies `pattern` until the string stops changing: one pass over `<scr<script>ipt>` leaves a new tag behind. */
function replaceUntilStable(text: string, pattern: RegExp, replacement: string): string {
  for (let previous = ''; previous !== text; ) {
    previous = text;
    text = text.replace(pattern, replacement);
  }
  return text;
}

/** HTML → readable plain text: block tags become line breaks, entities decode. */
export function htmlToText(html: string): string {
  const blocks = replaceUntilStable(html, /<(script|style|head)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|blockquote|table)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<a\s[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, text: string) => {
      const label = replaceUntilStable(text, /<[^>]+>/g, '').trim();
      return label && label !== href ? `${label} (${href})` : href;
    });
  return replaceUntilStable(blocks, /<[^>]+>/g, '')
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, code: string) => {
      if (code.startsWith('#x') || code.startsWith('#X')) return String.fromCodePoint(parseInt(code.slice(2), 16));
      if (code.startsWith('#')) return String.fromCodePoint(parseInt(code.slice(1), 10));
      return ENTITIES[code.toLowerCase()] ?? match;
    })
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function walk(part: GmailPart | undefined, visit: (part: GmailPart) => void): void {
  if (!part) return;
  visit(part);
  for (const child of part.parts ?? []) walk(child, visit);
}

function partText(part: GmailPart): string {
  return part.body?.data ? new TextDecoder().decode(decodeBase64Url(part.body.data)) : '';
}

/** The message body as text: the text/plain part, else the HTML part as text. */
export function messageText(payload: GmailPart | undefined): string {
  let plain = '';
  let html = '';
  walk(payload, (part) => {
    if (part.filename || part.body?.attachmentId) return;
    if (!plain && part.mimeType === 'text/plain') plain = partText(part);
    if (!html && part.mimeType === 'text/html') html = partText(part);
  });
  return plain.trim() ? plain : htmlToText(html);
}

/** The HTML body, when the message has one. */
export function messageHtml(payload: GmailPart | undefined): string {
  let html = '';
  walk(payload, (part) => {
    if (!html && part.mimeType === 'text/html' && !part.filename) html = partText(part);
  });
  return html;
}

export function attachmentList(payload: GmailPart | undefined): MessageAttachment[] {
  const list: MessageAttachment[] = [];
  walk(payload, (part) => {
    if (!part.body?.attachmentId) return;
    list.push({
      filename: part.filename ?? '',
      mimeType: part.mimeType ?? 'application/octet-stream',
      attachmentId: part.body.attachmentId,
      size: part.body.size ?? 0,
      partId: part.partId ?? null,
    });
  });
  return list;
}

export const messageUrl = (id: string): string => `https://mail.google.com/mail/u/0/#all/${id}`;

export function timestamp(internalDate: string | undefined): string {
  const ms = Number(internalDate);
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : '';
}

/** One Gmail API message (format `full` or `metadata`) as a Composio `MessageBody`. */
export function toMessageBody(message: GmailMessage, opts: { includePayload: boolean }): MessageBody {
  const payload = message.payload;
  const subject = header(payload, 'Subject');
  const cc = header(payload, 'Cc');
  const bcc = header(payload, 'Bcc');
  const id = message.id ?? '';
  return {
    messageId: id,
    threadId: message.threadId ?? '',
    labelIds: message.labelIds ?? [],
    subject,
    sender: header(payload, 'From'),
    to: header(payload, 'To'),
    ...(cc ? { cc } : {}),
    ...(bcc ? { bcc } : {}),
    messageTimestamp: timestamp(message.internalDate),
    messageText: messageText(payload),
    preview: { subject, body: message.snippet ?? '' },
    attachmentList: attachmentList(payload),
    display_url: messageUrl(id),
    ...(opts.includePayload && payload ? { payload } : {}),
  };
}
