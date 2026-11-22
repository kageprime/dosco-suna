import { describe, expect, test } from 'bun:test';
import { buildMime, encodeHeader, rawMessage } from './gmail-mime';
import { attachmentList, decodeBase64Url, htmlToText, messageText, toMessageBody, type GmailMessage } from './gmail-message';

const decode = (base64: string) => Buffer.from(base64.replace(/\r\n/g, ''), 'base64').toString('utf8');

describe('buildMime', () => {
  test('a plain message carries its headers and a base64 UTF-8 body', () => {
    const mime = buildMime({ to: ['a@example.com'], cc: [], bcc: [], subject: 'Hello', body: 'Line 1\nČau', isHtml: false, attachments: [] });
    expect(mime).toContain('To: a@example.com\r\n');
    expect(mime).toContain('Subject: Hello\r\n');
    expect(mime).toContain('Content-Type: text/plain; charset="UTF-8"');
    const body = mime.split('\r\n\r\n')[1]!;
    expect(decode(body)).toBe('Line 1\nČau');
  });

  test('non-ASCII subjects and display names are RFC 2047 encoded, addresses kept', () => {
    expect(encodeHeader('Plain subject')).toBe('Plain subject');
    expect(encodeHeader('Grüße')).toBe(`=?UTF-8?B?${Buffer.from('Grüße').toString('base64')}?=`);
    const mime = buildMime({ to: ['Jürgen Ä <j@example.com>'], cc: [], bcc: [], subject: 'Grüße', body: '', isHtml: false, attachments: [] });
    expect(mime).toContain(`To: =?UTF-8?B?${Buffer.from('Jürgen Ä').toString('base64')}?= <j@example.com>`);
  });

  test('an HTML message has a text alternative, attachments make it multipart/mixed', () => {
    const mime = buildMime({
      to: ['a@example.com'],
      cc: ['c@example.com'],
      bcc: ['b@example.com'],
      subject: 'Report',
      body: '<p>See <b>attached</b></p>',
      isHtml: true,
      attachments: [{ filename: 'r.pdf', mimeType: 'application/pdf', data: new Uint8Array([1, 2, 3]) }],
      inReplyTo: '<m1@mail>',
      references: '<m0@mail> <m1@mail>',
    });
    expect(mime).toMatch(/Content-Type: multipart\/mixed; boundary="kortix_[0-9a-f]+"/);
    expect(mime).toMatch(/Content-Type: multipart\/alternative; boundary="kortix_[0-9a-f]+"/);
    expect(mime).toContain('Content-Type: text/html; charset="UTF-8"');
    expect(mime).toContain('Content-Disposition: attachment; filename="r.pdf"');
    expect(mime).toContain(`${Buffer.from([1, 2, 3]).toString('base64')}\r\n`);
    expect(mime).toContain('Cc: c@example.com\r\n');
    expect(mime).toContain('Bcc: b@example.com\r\n');
    expect(mime).toContain('In-Reply-To: <m1@mail>\r\n');
    expect(mime).toContain('References: <m0@mail> <m1@mail>\r\n');
  });

  test('rawMessage is base64url with no padding', () => {
    const raw = rawMessage({ to: ['a@example.com'], cc: [], bcc: [], subject: '???>>>', body: 'x', isHtml: false, attachments: [] });
    expect(raw).not.toMatch(/[+/=]/);
    expect(new TextDecoder().decode(decodeBase64Url(raw))).toContain('Subject: ???>>>');
  });
});

describe('Gmail message parsing', () => {
  const b64url = (text: string) => Buffer.from(text).toString('base64url');
  const message: GmailMessage = {
    id: '18c1',
    threadId: '18c0',
    labelIds: ['INBOX', 'UNREAD'],
    snippet: 'Hi there',
    internalDate: '1700000000000',
    payload: {
      mimeType: 'multipart/mixed',
      headers: [
        { name: 'From', value: 'Ann <ann@example.com>' },
        { name: 'To', value: 'me@example.com' },
        { name: 'subject', value: 'Quarterly numbers' },
        { name: 'Cc', value: 'cc@example.com' },
      ],
      parts: [
        {
          mimeType: 'multipart/alternative',
          parts: [
            { mimeType: 'text/plain', body: { data: b64url('Hi there\nThe numbers are attached.') } },
            { mimeType: 'text/html', body: { data: b64url('<p>Hi there</p>') } },
          ],
        },
        { partId: '1', mimeType: 'application/pdf', filename: 'q3.pdf', body: { attachmentId: 'ANGj1', size: 2048 } },
      ],
    },
  };

  test('maps to the Composio MessageBody fields', () => {
    const body = toMessageBody(message, { includePayload: false });
    expect(body).toEqual({
      messageId: '18c1',
      threadId: '18c0',
      labelIds: ['INBOX', 'UNREAD'],
      subject: 'Quarterly numbers',
      sender: 'Ann <ann@example.com>',
      to: 'me@example.com',
      cc: 'cc@example.com',
      messageTimestamp: '2023-11-14T22:13:20.000Z',
      messageText: 'Hi there\nThe numbers are attached.',
      preview: { subject: 'Quarterly numbers', body: 'Hi there' },
      attachmentList: [{ filename: 'q3.pdf', mimeType: 'application/pdf', attachmentId: 'ANGj1', size: 2048, partId: '1' }],
      display_url: 'https://mail.google.com/mail/u/0/#all/18c1',
    });
    expect(toMessageBody(message, { includePayload: true }).payload).toBe(message.payload);
  });

  test('an HTML-only message becomes readable text', () => {
    const html = '<html><head><style>p{}</style></head><body><p>Hello&nbsp;<b>Bob</b></p><ul><li>One</li><li>Two</li></ul><a href="https://x.test/a">Open</a> &amp; &#x263A;</body></html>';
    expect(htmlToText(html)).toBe('Hello Bob\n- One\n- Two\nOpen (https://x.test/a) & ☺');
    expect(messageText({ mimeType: 'text/html', body: { data: b64url(html) } })).toContain('Hello Bob');
  });

  test('attachment parts are listed, inline body parts are not', () => {
    expect(attachmentList({ mimeType: 'text/plain', body: { data: b64url('x') } })).toEqual([]);
    expect(attachmentList(message.payload).map((a) => a.attachmentId)).toEqual(['ANGj1']);
  });
});
