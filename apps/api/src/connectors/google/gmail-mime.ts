/**
 * RFC 5322 / MIME messages for Gmail's `raw` field: plain or HTML bodies,
 * attachments, RFC 2047 headers, reply threading headers.
 */
import { encodeBase64Url, htmlToText } from './gmail-message';
import type { FileInput } from './files';

export interface OutgoingMail {
  from?: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  isHtml: boolean;
  attachments: FileInput[];
  inReplyTo?: string;
  references?: string;
}

const CRLF = '\r\n';

/** RFC 2047 encoded-word for a header value that is not plain ASCII. */
export function encodeHeader(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

/** An address list header: a display name that is not ASCII is encoded, the address kept. */
function addressHeader(addresses: string[]): string {
  return addresses
    .map((address) => {
      const match = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(address);
      if (!match) return address.trim();
      const name = match[1]!.trim();
      return name ? `${encodeHeader(name)} <${match[2]!.trim()}>` : match[2]!.trim();
    })
    .join(', ');
}

function wrap76(base64: string): string {
  return base64.replace(/.{1,76}/g, (line) => `${line}${CRLF}`);
}

function boundary(): string {
  return `kortix_${crypto.randomUUID().replace(/-/g, '')}`;
}

function textPart(contentType: string, text: string): string {
  return [
    `Content-Type: ${contentType}; charset="UTF-8"`,
    'Content-Transfer-Encoding: base64',
    '',
    wrap76(Buffer.from(text, 'utf8').toString('base64')),
  ].join(CRLF);
}

function fileName(name: string): string {
  // eslint-disable-next-line no-control-regex
  return /^[\x20-\x7e]*$/.test(name) ? `"${name.replace(/"/g, '')}"` : encodeHeader(name);
}

function filePart(file: FileInput): string {
  return [
    `Content-Type: ${file.mimeType}; name=${fileName(file.filename)}`,
    `Content-Disposition: attachment; filename=${fileName(file.filename)}`,
    'Content-Transfer-Encoding: base64',
    '',
    wrap76(Buffer.from(file.data).toString('base64')),
  ].join(CRLF);
}

/** Plain text newlines as HTML line breaks, with the text escaped. */
export function textToHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\r?\n/g, '<br>');
}

function bodyPart(mail: OutgoingMail): string {
  if (!mail.isHtml) return textPart('text/plain', mail.body);
  const alt = boundary();
  return [
    `Content-Type: multipart/alternative; boundary="${alt}"`,
    '',
    `--${alt}`,
    textPart('text/plain', htmlToText(mail.body)),
    `--${alt}`,
    textPart('text/html', mail.body),
    `--${alt}--`,
    '',
  ].join(CRLF);
}

/** The whole message as RFC 5322 text. */
export function buildMime(mail: OutgoingMail): string {
  const headers: string[] = ['MIME-Version: 1.0'];
  if (mail.from) headers.push(`From: ${addressHeader([mail.from])}`);
  if (mail.to.length) headers.push(`To: ${addressHeader(mail.to)}`);
  if (mail.cc.length) headers.push(`Cc: ${addressHeader(mail.cc)}`);
  if (mail.bcc.length) headers.push(`Bcc: ${addressHeader(mail.bcc)}`);
  headers.push(`Subject: ${encodeHeader(mail.subject)}`);
  if (mail.inReplyTo) headers.push(`In-Reply-To: ${mail.inReplyTo}`);
  if (mail.references) headers.push(`References: ${mail.references}`);
  if (!mail.attachments.length) return [...headers, bodyPart(mail)].join(CRLF);
  const mixed = boundary();
  return [
    ...headers,
    `Content-Type: multipart/mixed; boundary="${mixed}"`,
    '',
    `--${mixed}`,
    bodyPart(mail),
    ...mail.attachments.flatMap((file) => [`--${mixed}`, filePart(file)]),
    `--${mixed}--`,
    '',
  ].join(CRLF);
}

/** The message as Gmail's `raw`: base64url of the RFC 5322 text. */
export function rawMessage(mail: OutgoingMail): string {
  return encodeBase64Url(buildMime(mail));
}
