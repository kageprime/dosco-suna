/**
 * Kortix Gmail MCP server tools. Names and arguments follow Composio's Gmail
 * toolkit (`fetch_emails`, `send_email`, `reply_to_thread`, …); see ./tool.ts.
 *
 * Scopes: `gmail.modify` (read, send, drafts, labels, trash) and
 * `gmail.settings.basic` (filters, vacation, IMAP/POP, send-as), plus
 * `contacts.readonly` / `contacts.other.readonly` for the People tools.
 * Kortix does not ask for full mailbox access (`https://mail.google.com/`),
 * so the delete tools move mail to Trash, where Gmail deletes it after 30 days.
 */
import { resolveFiles, fileOutput, guessMimeType, FILE_ITEM_SCHEMA } from './files';
import { rawMessage, textToHtml, type OutgoingMail } from './gmail-mime';
import {
  attachmentList,
  decodeBase64Url,
  encodeBase64Url,
  header,
  messageHtml,
  messageText,
  messageUrl,
  toMessageBody,
  type GmailMessage,
} from './gmail-message';
import {
  DESTRUCTIVE,
  READ,
  ToolInputError,
  USER_ID,
  WRITE,
  anyObj,
  arr,
  b,
  i,
  mapLimit,
  optBool,
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
  type ToolContext,
} from './tool';

const G = 'https://gmail.googleapis.com/gmail/v1/users/me';
const PEOPLE = 'https://people.googleapis.com/v1';
const DETAIL_CONCURRENCY = 10;
const DEFAULT_PERSON_FIELDS = 'names,emailAddresses,phoneNumbers,organizations';

const TRASH_NOTE =
  ' Kortix moves it to Trash (Gmail deletes Trash after 30 days): Kortix does not ask for the full mailbox access a permanent delete needs.';

type Json = Record<string, unknown>;

// ─── Shared reads ───────────────────────────────────────────────────────────

const getMessage = (ctx: ToolContext, id: string, format: string) =>
  ctx.google.json<GmailMessage>({
    url: `${G}/messages/${encodeURIComponent(id)}`,
    query: { format, ...(format === 'metadata' ? { metadataHeaders: ['Subject', 'From', 'To', 'Cc', 'Date'] } : {}) },
  });

/** Detail fetches that answer 404, 429 or 503 are skipped, as Composio did. */
async function detailOrSkip<T>(work: () => Promise<T>): Promise<T | null> {
  try {
    return await work();
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status === 404 || status === 429 || status === 503) return null;
    throw error;
  }
}

async function myAddress(ctx: ToolContext): Promise<string> {
  const profile = await ctx.google.json<{ emailAddress?: string }>({ url: `${G}/profile` });
  return profile?.emailAddress ?? '';
}

/** The default send-as signature (HTML), or '' when there is none. */
async function defaultSignature(ctx: ToolContext): Promise<string> {
  const list = await ctx.google.json<{ sendAs?: Array<{ isDefault?: boolean; isPrimary?: boolean; signature?: string }> }>({ url: `${G}/settings/sendAs` });
  const entry = list?.sendAs?.find((a) => a.isDefault) ?? list?.sendAs?.find((a) => a.isPrimary);
  return entry?.signature?.trim() ?? '';
}

// ─── Composing ──────────────────────────────────────────────────────────────

const COMPOSE_PROPS = {
  recipient_email: s('Primary recipient address. `to` is an alias.'),
  to: s('Alias of recipient_email.'),
  extra_recipients: strs('More To addresses.'),
  cc: strs('Cc addresses.'),
  bcc: strs('Bcc addresses.'),
  subject: s('Subject line.'),
  body: s('Message body, plain text or HTML (set is_html).'),
  is_html: b('True when body is HTML.', { default: false }),
  include_signature: b("Append the account's Gmail signature.", { default: true }),
  attachments: arr(FILE_ITEM_SCHEMA, 'Files to attach. `kortix connectors call --attach <file>` adds one here.'),
  attachment: { description: 'Composio-style file or list of files ({name, mimetype, content|url}).' },
  user_id: USER_ID,
};

async function composeMail(ctx: ToolContext, args: Json, opts: { bodyKey?: string; requireRecipient: boolean }): Promise<OutgoingMail> {
  const to = [...strList(args, 'recipient_email', 'to'), ...strList(args, 'extra_recipients')];
  const cc = strList(args, 'cc');
  const bcc = strList(args, 'bcc');
  if (opts.requireRecipient && !to.length && !cc.length && !bcc.length) {
    throw new ToolInputError('recipient_email (or to, cc, bcc) is required');
  }
  let body = optStr(args, opts.bodyKey ?? 'body', 'body', 'message_body') ?? '';
  let isHtml = optBool(args, 'is_html', false);
  if (optBool(args, 'include_signature', true)) {
    const signature = await defaultSignature(ctx).catch(() => '');
    if (signature) {
      if (!isHtml) {
        body = textToHtml(body);
        isHtml = true;
      }
      body = body ? `${body}<br><br>${signature}` : signature;
    }
  }
  return {
    from: optStr(args, 'from_email'),
    to,
    cc,
    bcc,
    subject: optStr(args, 'subject') ?? '',
    body,
    isHtml,
    attachments: await resolveFiles(args),
  };
}

function sentMessage(message: Json | null): Json {
  const id = typeof message?.id === 'string' ? message.id : '';
  return { ...message, display_url: messageUrl(id) };
}

interface ReplyContext {
  threadId: string;
  subject: string;
  inReplyTo?: string;
  references?: string;
  replyTo: string[];
}

/** Threading headers and default recipients for a reply to the thread's last message. */
async function replyContext(ctx: ToolContext, threadId: string): Promise<ReplyContext> {
  const thread = await ctx.google.json<{ messages?: GmailMessage[] }>({
    url: `${G}/threads/${encodeURIComponent(threadId)}`,
    query: { format: 'metadata', metadataHeaders: ['Subject', 'From', 'To', 'Cc', 'Reply-To', 'Message-ID', 'References'] },
  });
  const messages = thread?.messages ?? [];
  const last = messages[messages.length - 1];
  if (!last) throw new ToolInputError(`thread ${threadId} has no messages`);
  const me = (await myAddress(ctx)).toLowerCase();
  const from = header(last.payload, 'Reply-To') || header(last.payload, 'From');
  const fromMe = me !== '' && from.toLowerCase().includes(me);
  const replyTo = (fromMe ? header(last.payload, 'To') : from).split(',').map((a) => a.trim()).filter(Boolean);
  const subject = header(last.payload, 'Subject');
  const messageId = header(last.payload, 'Message-ID');
  const references = [header(last.payload, 'References'), messageId].filter(Boolean).join(' ');
  return {
    threadId,
    subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`,
    ...(messageId ? { inReplyTo: messageId } : {}),
    ...(references ? { references } : {}),
    replyTo,
  };
}

// ─── Read tools ─────────────────────────────────────────────────────────────

const fetchEmails: GoogleTool = {
  name: 'fetch_emails',
  title: 'Fetch emails',
  description:
    'List emails matching a Gmail search, with sender, subject, text and attachments. Set max_results above the default 1 for more. Page with page_token.',
  inputSchema: schema({
    query: s('Gmail search, such as `from:alice@example.com is:unread newer_than:7d`.'),
    label_ids: strs('Only messages with all of these label ids (INBOX, UNREAD, …).'),
    max_results: i('Messages per page, 1–500.', { default: 1 }),
    page_token: s('nextPageToken of the previous page.'),
    include_payload: b('Include the full Gmail payload (headers, parts).', { default: true }),
    include_spam_trash: b('Include Spam and Trash.', { default: false }),
    ids_only: b('Return only message and thread ids (fastest).', { default: false }),
    verbose: b('False: metadata only (subject, sender, snippet), no body.', { default: true }),
    user_id: USER_ID,
  }),
  annotations: READ,
  async run(args, ctx) {
    const list = await ctx.google.json<{ messages?: Array<{ id: string; threadId: string }>; nextPageToken?: string; resultSizeEstimate?: number }>({
      url: `${G}/messages`,
      query: {
        q: optStr(args, 'query', 'q'),
        labelIds: strList(args, 'label_ids'),
        maxResults: optInt(args, 'max_results', 1, 500),
        pageToken: optStr(args, 'page_token', 'pageToken'),
        includeSpamTrash: optBool(args, 'include_spam_trash', false) || undefined,
      },
    });
    const refs = list?.messages ?? [];
    const page = { nextPageToken: list?.nextPageToken ?? '', resultSizeEstimate: list?.resultSizeEstimate ?? 0 };
    if (optBool(args, 'ids_only', false)) {
      return { messages: refs.map((m) => ({ messageId: m.id, threadId: m.threadId })), ...page };
    }
    const full = optBool(args, 'include_payload', true) && optBool(args, 'verbose', true);
    const details = await mapLimit(refs, DETAIL_CONCURRENCY, (m) => detailOrSkip(() => getMessage(ctx, m.id, full ? 'full' : 'metadata')));
    const messages = details.filter((m): m is GmailMessage => m !== null).map((m) => toMessageBody(m, { includePayload: full }));
    return { messages, ...page };
  },
};

const fetchMessageByMessageId: GoogleTool = {
  name: 'fetch_message_by_message_id',
  title: 'Fetch email by message id',
  description: 'Read one email: sender, recipients, subject, text, attachment list and payload.',
  inputSchema: schema(
    {
      message_id: s('Gmail message id.'),
      format: s('full (default), metadata, minimal or raw.', { enum: ['full', 'metadata', 'minimal', 'raw'], default: 'full' }),
      user_id: USER_ID,
    },
    ['message_id'],
  ),
  annotations: READ,
  async run(args, ctx) {
    const format = optStr(args, 'format') ?? 'full';
    const message = await getMessage(ctx, reqStr(args, 'message_id', 'id'), format);
    return { ...toMessageBody(message, { includePayload: true }), ...(message.raw ? { raw: message.raw } : {}), historyId: message.historyId ?? '' };
  },
};

const fetchMessageByThreadId: GoogleTool = {
  name: 'fetch_message_by_thread_id',
  title: 'Fetch email thread',
  description: 'Read every email of a thread, oldest first, with text and attachments.',
  inputSchema: schema({ thread_id: s('Gmail thread id.'), page_token: s('Unused; Gmail returns a whole thread.'), user_id: USER_ID }, ['thread_id']),
  annotations: READ,
  async run(args, ctx) {
    const threadId = reqStr(args, 'thread_id', 'id');
    const thread = await ctx.google.json<{ id?: string; historyId?: string; messages?: GmailMessage[] }>({
      url: `${G}/threads/${encodeURIComponent(threadId)}`,
      query: { format: 'full' },
    });
    return {
      threadId: thread?.id ?? threadId,
      historyId: thread?.historyId ?? '',
      messages: (thread?.messages ?? []).map((m) => toMessageBody(m, { includePayload: true })),
      display_url: messageUrl(threadId),
    };
  },
};

const listMessages: GoogleTool = {
  name: 'list_messages',
  title: 'List message ids',
  description: 'List message and thread ids matching a Gmail search. fetch_emails returns the content too.',
  inputSchema: schema({
    q: s('Gmail search.'),
    label_ids: strs('Only messages with all of these label ids.'),
    max_results: i('Ids per page, 1–500.', { default: 100 }),
    page_token: s('nextPageToken of the previous page.'),
    include_spam_trash: b('Include Spam and Trash.', { default: false }),
    user_id: USER_ID,
  }),
  annotations: READ,
  async run(args, ctx) {
    const list = await ctx.google.json<Json>({
      url: `${G}/messages`,
      query: {
        q: optStr(args, 'q', 'query'),
        labelIds: strList(args, 'label_ids'),
        maxResults: optInt(args, 'max_results', 100, 500),
        pageToken: optStr(args, 'page_token', 'pageToken'),
        includeSpamTrash: optBool(args, 'include_spam_trash', false) || undefined,
      },
    });
    return { messages: list?.messages ?? [], nextPageToken: list?.nextPageToken ?? '', resultSizeEstimate: list?.resultSizeEstimate ?? 0 };
  },
};

const listThreads: GoogleTool = {
  name: 'list_threads',
  title: 'List threads',
  description: 'List email threads matching a Gmail search. verbose adds each thread\'s messages (headers and snippet).',
  inputSchema: schema({
    query: s('Gmail search, such as `is:unread in:inbox`.'),
    max_results: i('Threads per page, 1–500.', { default: 10 }),
    page_token: s('nextPageToken of the previous page.'),
    verbose: b('Include each thread\'s messages.', { default: false }),
    user_id: USER_ID,
  }),
  annotations: READ,
  async run(args, ctx) {
    const list = await ctx.google.json<{ threads?: Array<{ id: string; snippet?: string; historyId?: string }>; nextPageToken?: string; resultSizeEstimate?: number }>({
      url: `${G}/threads`,
      query: { q: optStr(args, 'query', 'q'), maxResults: optInt(args, 'max_results', 10, 500), pageToken: optStr(args, 'page_token', 'pageToken') },
    });
    let threads: unknown[] = list?.threads ?? [];
    if (optBool(args, 'verbose', false)) {
      threads = await mapLimit(list?.threads ?? [], DETAIL_CONCURRENCY, async (t) => {
        const thread = await detailOrSkip(() =>
          ctx.google.json<{ messages?: GmailMessage[] }>({
            url: `${G}/threads/${encodeURIComponent(t.id)}`,
            query: { format: 'metadata', metadataHeaders: ['Subject', 'From', 'To', 'Cc', 'Date'] },
          }),
        );
        return { ...t, messages: (thread?.messages ?? []).map((m) => toMessageBody(m, { includePayload: false })) };
      });
    }
    return { threads, nextPageToken: list?.nextPageToken ?? '', resultSizeEstimate: list?.resultSizeEstimate ?? 0 };
  },
};

const getAttachment: GoogleTool = {
  name: 'get_attachment',
  title: 'Download attachment',
  description:
    'Download one attachment of an email as base64 (`file.content_base64`). Get attachment_id from attachmentList. ' +
    'For a large file pass `--out result.json` to `kortix connectors call`, then decode it.',
  inputSchema: schema(
    { message_id: s('Gmail message id.'), attachment_id: s('attachmentId from attachmentList (not the file name).'), file_name: s('File name for the download.'), user_id: USER_ID },
    ['message_id', 'attachment_id'],
  ),
  annotations: READ,
  async run(args, ctx) {
    const messageId = reqStr(args, 'message_id');
    const attachmentId = reqStr(args, 'attachment_id');
    const body = await ctx.google.json<{ data?: string }>({
      url: `${G}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
    });
    const fileName = optStr(args, 'file_name') ?? 'attachment';
    return { file: fileOutput(fileName, guessMimeType(fileName), decodeBase64Url(body?.data ?? '')), display_url: messageUrl(messageId) };
  },
};

const getProfile: GoogleTool = {
  name: 'get_profile',
  title: 'Get Gmail profile',
  description: 'The account address and its message and thread counts.',
  inputSchema: schema({ user_id: USER_ID }),
  annotations: READ,
  run: (_args, ctx) => ctx.google.json({ url: `${G}/profile` }),
};

const whoAmI: GoogleTool = {
  name: 'who_am_i',
  title: 'Who am I',
  description: 'The connected Google account: email, name and picture.',
  inputSchema: schema({}),
  annotations: READ,
  async run(_args, ctx) {
    const [profile, info] = await Promise.all([
      ctx.google.json<{ emailAddress?: string }>({ url: `${G}/profile` }),
      ctx.google.json<{ email?: string; name?: string; picture?: string; sub?: string }>({ url: 'https://openidconnect.googleapis.com/v1/userinfo' }).catch(() => null),
    ]);
    const email = profile?.emailAddress ?? info?.email ?? '';
    return { data: { email, name: info?.name ?? '', picture: info?.picture ?? '', id: info?.sub ?? '' }, display_name: info?.name || email };
  },
};

const listHistory: GoogleTool = {
  name: 'list_history',
  title: 'List mailbox history',
  description: 'Changes to the mailbox since start_history_id (messages added, deleted, labels changed).',
  inputSchema: schema(
    {
      start_history_id: s('historyId to start after (from get_profile or a message).'),
      history_types: strs('messageAdded, messageDeleted, labelAdded, labelRemoved.'),
      label_id: s('Only changes to messages with this label.'),
      max_results: i('Records per page, up to 500.', { default: 100 }),
      page_token: s('nextPageToken of the previous page.'),
      user_id: USER_ID,
    },
    ['start_history_id'],
  ),
  annotations: READ,
  run: (args, ctx) =>
    ctx.google.json({
      url: `${G}/history`,
      query: {
        startHistoryId: reqStr(args, 'start_history_id'),
        historyTypes: strList(args, 'history_types'),
        labelId: optStr(args, 'label_id'),
        maxResults: optInt(args, 'max_results', 100, 500),
        pageToken: optStr(args, 'page_token', 'pageToken'),
      },
    }),
};

// ─── Send, reply, forward, drafts ───────────────────────────────────────────

const sendEmail: GoogleTool = {
  name: 'send_email',
  title: 'Send email',
  description: 'Send an email from the connected account, with optional Cc, Bcc, HTML body and attachments.',
  inputSchema: schema({ ...COMPOSE_PROPS, from_email: s('From address: the account address or one of its send-as aliases.') }),
  annotations: WRITE,
  async run(args, ctx) {
    const mail = await composeMail(ctx, args, { requireRecipient: true });
    if (!mail.subject && !mail.body) throw new ToolInputError('subject or body is required');
    return sentMessage(await ctx.google.json({ method: 'POST', url: `${G}/messages/send`, body: { raw: rawMessage(mail) } }));
  },
};

const replyToThread: GoogleTool = {
  name: 'reply_to_thread',
  title: 'Reply to thread',
  description: 'Reply in an existing thread. Recipients default to the sender of the last message.',
  inputSchema: schema({ thread_id: s('Gmail thread id.'), message_body: s('Reply text, plain or HTML (is_html).'), ...COMPOSE_PROPS }, ['thread_id']),
  annotations: WRITE,
  async run(args, ctx) {
    const reply = await replyContext(ctx, reqStr(args, 'thread_id'));
    const mail = await composeMail(ctx, args, { bodyKey: 'message_body', requireRecipient: false });
    if (!mail.to.length) mail.to = reply.replyTo;
    mail.subject = optStr(args, 'subject') ?? reply.subject;
    mail.inReplyTo = reply.inReplyTo;
    mail.references = reply.references;
    return sentMessage(await ctx.google.json({ method: 'POST', url: `${G}/messages/send`, body: { raw: rawMessage(mail), threadId: reply.threadId } }));
  },
};

const forwardMessage: GoogleTool = {
  name: 'forward_message',
  title: 'Forward email',
  description: 'Forward an email, with its attachments, to new recipients. additional_text goes above the forwarded message.',
  inputSchema: schema(
    {
      message_id: s('Gmail message id to forward.'),
      recipients: strs('To addresses.'),
      additional_text: s('Your note above the forwarded message.'),
      cc: strs('Cc addresses.'),
      bcc: strs('Bcc addresses.'),
      include_signature: b("Append the account's Gmail signature.", { default: true }),
      user_id: USER_ID,
    },
    ['message_id', 'recipients'],
  ),
  annotations: WRITE,
  async run(args, ctx) {
    const original = await getMessage(ctx, reqStr(args, 'message_id'), 'full');
    const to = strList(args, 'recipients', 'recipient_email');
    if (!to.length) throw new ToolInputError('recipients is required');
    const payload = original.payload;
    const quoted = [
      '---------- Forwarded message ---------',
      `From: ${header(payload, 'From')}`,
      `Date: ${header(payload, 'Date')}`,
      `Subject: ${header(payload, 'Subject')}`,
      `To: ${header(payload, 'To')}`,
    ];
    const html = messageHtml(payload);
    const note = optStr(args, 'additional_text') ?? '';
    const body = html
      ? `${textToHtml(note)}<br><br>${quoted.map(textToHtml).join('<br>')}<br><br>${html}`
      : `${note}\n\n${quoted.join('\n')}\n\n${messageText(payload)}`;
    const attachments = await mapLimit(attachmentList(payload), 4, async (a) => {
      const data = await ctx.google.json<{ data?: string }>({
        url: `${G}/messages/${encodeURIComponent(original.id ?? '')}/attachments/${encodeURIComponent(a.attachmentId)}`,
      });
      return { filename: a.filename || 'attachment', mimeType: a.mimeType, data: decodeBase64Url(data?.data ?? '') };
    });
    let mailBody = body;
    let isHtml = Boolean(html);
    if (optBool(args, 'include_signature', true)) {
      const signature = await defaultSignature(ctx).catch(() => '');
      if (signature) {
        if (!isHtml) mailBody = textToHtml(mailBody);
        isHtml = true;
        mailBody = `${mailBody}<br><br>${signature}`;
      }
    }
    const subject = header(payload, 'Subject');
    const mail: OutgoingMail = {
      to,
      cc: strList(args, 'cc'),
      bcc: strList(args, 'bcc'),
      subject: /^fwd?:/i.test(subject) ? subject : `Fwd: ${subject}`,
      body: mailBody,
      isHtml,
      attachments,
    };
    return sentMessage(await ctx.google.json({ method: 'POST', url: `${G}/messages/send`, body: { raw: rawMessage(mail) } }));
  },
};

function draftBody(raw: string, threadId: string | undefined): Json {
  return { message: { raw, ...(threadId ? { threadId } : {}) } };
}

const createEmailDraft: GoogleTool = {
  name: 'create_email_draft',
  title: 'Create draft',
  description: 'Create a draft. With thread_id it is a reply draft in that thread. send_draft sends it.',
  inputSchema: schema({ ...COMPOSE_PROPS, thread_id: s('Thread to reply in; omit for a new conversation.') }),
  annotations: WRITE,
  async run(args, ctx) {
    const threadId = optStr(args, 'thread_id');
    const mail = await composeMail(ctx, args, { requireRecipient: false });
    if (threadId) {
      const reply = await replyContext(ctx, threadId);
      if (!mail.to.length) mail.to = reply.replyTo;
      if (!optStr(args, 'subject')) mail.subject = reply.subject;
      mail.inReplyTo = reply.inReplyTo;
      mail.references = reply.references;
    }
    return ctx.google.json({ method: 'POST', url: `${G}/drafts`, body: draftBody(rawMessage(mail), threadId) });
  },
};

const updateDraft: GoogleTool = {
  name: 'update_draft',
  title: 'Update draft',
  description: 'Replace the content of a draft. Fields you omit are emptied, as in Gmail.',
  inputSchema: schema({ draft_id: s('Draft id.'), ...COMPOSE_PROPS, thread_id: s('Thread of the draft, if any.') }, ['draft_id']),
  annotations: WRITE,
  async run(args, ctx) {
    const draftId = reqStr(args, 'draft_id');
    const mail = await composeMail(ctx, args, { requireRecipient: false });
    return ctx.google.json({ method: 'PUT', url: `${G}/drafts/${encodeURIComponent(draftId)}`, body: { id: draftId, ...draftBody(rawMessage(mail), optStr(args, 'thread_id')) } });
  },
};

const listDrafts: GoogleTool = {
  name: 'list_drafts',
  title: 'List drafts',
  description: 'List drafts. verbose adds each draft\'s recipients, subject and text.',
  inputSchema: schema({
    max_results: i('Drafts per page, 1–500.', { default: 10 }),
    page_token: s('nextPageToken of the previous page.'),
    verbose: b('Include each draft\'s message.', { default: false }),
    user_id: USER_ID,
  }),
  annotations: READ,
  async run(args, ctx) {
    const list = await ctx.google.json<{ drafts?: Array<{ id: string; message?: { id?: string; threadId?: string } }>; nextPageToken?: string; resultSizeEstimate?: number }>({
      url: `${G}/drafts`,
      query: { maxResults: optInt(args, 'max_results', 10, 500), pageToken: optStr(args, 'page_token', 'pageToken') },
    });
    let drafts: unknown[] = list?.drafts ?? [];
    if (optBool(args, 'verbose', false)) {
      drafts = await mapLimit(list?.drafts ?? [], DETAIL_CONCURRENCY, async (d) => {
        const draft = await detailOrSkip(() => ctx.google.json<{ id: string; message?: GmailMessage }>({ url: `${G}/drafts/${encodeURIComponent(d.id)}`, query: { format: 'full' } }));
        return draft?.message ? { id: d.id, message: toMessageBody(draft.message, { includePayload: false }) } : d;
      });
    }
    return { drafts, nextPageToken: list?.nextPageToken ?? '', resultSizeEstimate: list?.resultSizeEstimate ?? 0 };
  },
};

const getDraft: GoogleTool = {
  name: 'get_draft',
  title: 'Get draft',
  description: 'Read one draft: recipients, subject, text and attachments.',
  inputSchema: schema({ draft_id: s('Draft id.'), format: s('full (default), metadata, minimal or raw.', { default: 'full' }), user_id: USER_ID }, ['draft_id']),
  annotations: READ,
  async run(args, ctx) {
    const draft = await ctx.google.json<{ id: string; message?: GmailMessage }>({
      url: `${G}/drafts/${encodeURIComponent(reqStr(args, 'draft_id'))}`,
      query: { format: optStr(args, 'format') ?? 'full' },
    });
    return { id: draft?.id, message: draft?.message ? toMessageBody(draft.message, { includePayload: true }) : null };
  },
};

const sendDraft: GoogleTool = {
  name: 'send_draft',
  title: 'Send draft',
  description: 'Send an existing draft.',
  inputSchema: schema({ draft_id: s('Draft id.'), user_id: USER_ID }, ['draft_id']),
  annotations: WRITE,
  async run(args, ctx) {
    return sentMessage(await ctx.google.json({ method: 'POST', url: `${G}/drafts/send`, body: { id: reqStr(args, 'draft_id') } }));
  },
};

const deleteDraft: GoogleTool = {
  name: 'delete_draft',
  title: 'Delete draft',
  description: 'Delete a draft permanently.',
  inputSchema: schema({ draft_id: s('Draft id.'), user_id: USER_ID }, ['draft_id']),
  annotations: DESTRUCTIVE,
  async run(args, ctx) {
    const draftId = reqStr(args, 'draft_id');
    await ctx.google.json({ method: 'DELETE', url: `${G}/drafts/${encodeURIComponent(draftId)}` });
    return { deleted: true, draft_id: draftId };
  },
};

// ─── Labels and trash ───────────────────────────────────────────────────────

function modify(path: string, add: string[], remove: string[]): { method: 'POST'; url: string; body: Json } {
  if (!add.length && !remove.length) throw new ToolInputError('add_label_ids or remove_label_ids is required');
  return { method: 'POST', url: `${G}/${path}`, body: { addLabelIds: add, removeLabelIds: remove } };
}

const addLabelToEmail: GoogleTool = {
  name: 'add_label_to_email',
  title: 'Change email labels',
  description: 'Add and remove labels on one email. Remove UNREAD to mark it read, INBOX to archive it.',
  inputSchema: schema({ message_id: s('Gmail message id.'), add_label_ids: strs('Label ids to add.'), remove_label_ids: strs('Label ids to remove.'), user_id: USER_ID }, ['message_id']),
  annotations: { ...WRITE, idempotentHint: true },
  run: (args, ctx) => ctx.google.json(modify(`messages/${encodeURIComponent(reqStr(args, 'message_id'))}/modify`, strList(args, 'add_label_ids'), strList(args, 'remove_label_ids'))),
};

const modifyThreadLabels: GoogleTool = {
  name: 'modify_thread_labels',
  title: 'Change thread labels',
  description: 'Add and remove labels on every email of a thread.',
  inputSchema: schema({ thread_id: s('Gmail thread id.'), add_label_ids: strs('Label ids to add.'), remove_label_ids: strs('Label ids to remove.'), user_id: USER_ID }, ['thread_id']),
  annotations: { ...WRITE, idempotentHint: true },
  run: (args, ctx) => ctx.google.json(modify(`threads/${encodeURIComponent(reqStr(args, 'thread_id'))}/modify`, strList(args, 'add_label_ids'), strList(args, 'remove_label_ids'))),
};

const batchModifyMessages: GoogleTool = {
  name: 'batch_modify_messages',
  title: 'Change labels of many emails',
  description: 'Add and remove labels on up to 1,000 emails at once.',
  inputSchema: schema({ messageIds: strs('Gmail message ids.'), addLabelIds: strs('Label ids to add.'), removeLabelIds: strs('Label ids to remove.'), userId: USER_ID }, ['messageIds']),
  annotations: { ...WRITE, idempotentHint: true },
  async run(args, ctx) {
    const ids = strList(args, 'messageIds', 'message_ids');
    if (!ids.length) throw new ToolInputError('messageIds is required');
    const add = strList(args, 'addLabelIds', 'add_label_ids');
    const remove = strList(args, 'removeLabelIds', 'remove_label_ids');
    await ctx.google.json({ ...modify('messages/batchModify', add, remove), body: { ids, addLabelIds: add, removeLabelIds: remove } });
    return { modified: ids.length };
  },
};

function trashTool(name: string, title: string, kind: 'messages' | 'threads', key: string, action: 'trash' | 'untrash', note = ''): GoogleTool {
  return {
    name,
    title,
    description: `${action === 'trash' ? 'Move' : 'Restore'} ${kind === 'messages' ? 'an email' : 'a whole thread'} ${action === 'trash' ? 'to' : 'from'} Trash.${note}`,
    inputSchema: schema({ [key]: s(kind === 'messages' ? 'Gmail message id.' : 'Gmail thread id.'), user_id: USER_ID }, [key]),
    annotations: action === 'trash' ? DESTRUCTIVE : WRITE,
    async run(args, ctx) {
      const id = reqStr(args, key, 'id', kind === 'messages' ? 'message_id' : 'thread_id');
      const result = await ctx.google.json<Json>({ method: 'POST', url: `${G}/${kind}/${encodeURIComponent(id)}/${action}` });
      return note ? { ...result, trashed: true, permanently_deleted: false } : result;
    },
  };
}

const batchDeleteMessages: GoogleTool = {
  name: 'batch_delete_messages',
  title: 'Trash many emails',
  description: `Move many emails to Trash.${TRASH_NOTE}`,
  inputSchema: schema({ messageIds: strs('Gmail message ids.'), userId: USER_ID }, ['messageIds']),
  annotations: DESTRUCTIVE,
  async run(args, ctx) {
    const ids = strList(args, 'messageIds', 'message_ids');
    if (!ids.length) throw new ToolInputError('messageIds is required');
    await ctx.google.json({ method: 'POST', url: `${G}/messages/batchModify`, body: { ids, addLabelIds: ['TRASH'], removeLabelIds: ['INBOX'] } });
    return { trashed: ids.length, permanently_deleted: false };
  },
};

const LABEL_PROPS = {
  name: s('Label name.'),
  labelListVisibility: s('labelShow, labelShowIfUnread or labelHide.'),
  messageListVisibility: s('show or hide.'),
  color: anyObj('{textColor, backgroundColor} from Gmail\'s palette.'),
  userId: USER_ID,
};

const listLabels: GoogleTool = {
  name: 'list_labels',
  title: 'List labels',
  description: 'List every label with its id. include_details adds message and thread counts.',
  inputSchema: schema({ include_details: b('Add counts (one request per label).', { default: false }), user_id: USER_ID }),
  annotations: READ,
  async run(args, ctx) {
    const list = await ctx.google.json<{ labels?: Array<{ id: string }> }>({ url: `${G}/labels` });
    if (!optBool(args, 'include_details', false)) return { labels: list?.labels ?? [] };
    const labels = await mapLimit(list?.labels ?? [], DETAIL_CONCURRENCY, (l) => ctx.google.json<Json>({ url: `${G}/labels/${encodeURIComponent(l.id)}` }));
    return { labels };
  },
};

const getLabel: GoogleTool = {
  name: 'get_label',
  title: 'Get label',
  description: 'One label with its message and thread counts.',
  inputSchema: schema({ id: s('Label id.'), user_id: USER_ID }, ['id']),
  annotations: READ,
  run: (args, ctx) => ctx.google.json({ url: `${G}/labels/${encodeURIComponent(reqStr(args, 'id', 'label_id'))}` }),
};

const createLabel: GoogleTool = {
  name: 'create_label',
  title: 'Create label',
  description: 'Create a label. Nest it with a slash: `Clients/Acme`.',
  inputSchema: schema(
    {
      label_name: s('Label name.'),
      label_list_visibility: s('labelShow (default), labelShowIfUnread or labelHide.'),
      message_list_visibility: s('show (default) or hide.'),
      text_color: s('Text color from Gmail\'s palette, such as #000000.'),
      background_color: s('Background color from Gmail\'s palette, such as #16a765.'),
      user_id: USER_ID,
    },
    ['label_name'],
  ),
  annotations: WRITE,
  run(args, ctx) {
    const text = optStr(args, 'text_color');
    const background = optStr(args, 'background_color');
    return ctx.google.json({
      method: 'POST',
      url: `${G}/labels`,
      body: {
        name: reqStr(args, 'label_name', 'name'),
        labelListVisibility: optStr(args, 'label_list_visibility') ?? 'labelShow',
        messageListVisibility: optStr(args, 'message_list_visibility') ?? 'show',
        ...(text || background ? { color: { textColor: text ?? '#000000', backgroundColor: background ?? '#ffffff' } } : {}),
      },
    });
  },
};

function labelUpdate(name: string, method: 'PATCH' | 'PUT'): GoogleTool {
  return {
    name,
    title: method === 'PATCH' ? 'Edit label' : 'Replace label',
    description: method === 'PATCH' ? 'Change a label\'s name, visibility or color; omitted fields stay.' : 'Replace a label\'s name, visibility and color.',
    inputSchema: schema({ id: s('Label id.'), ...LABEL_PROPS }, ['id']),
    annotations: { ...WRITE, idempotentHint: true },
    run: (args, ctx) =>
      ctx.google.json({
        method,
        url: `${G}/labels/${encodeURIComponent(reqStr(args, 'id', 'label_id'))}`,
        body: pick(args, ['name', 'labelListVisibility', 'messageListVisibility', 'color']),
      }),
  };
}

function labelDelete(name: string, deprecated: boolean): GoogleTool {
  return {
    name,
    title: 'Delete label',
    description: `Delete a label. Its emails stay; they lose the label.${deprecated ? ' Same as delete_label.' : ''}`,
    inputSchema: schema({ label_id: s('Label id.'), user_id: USER_ID }, ['label_id']),
    annotations: DESTRUCTIVE,
    async run(args, ctx) {
      const id = reqStr(args, 'label_id', 'id');
      await ctx.google.json({ method: 'DELETE', url: `${G}/labels/${encodeURIComponent(id)}` });
      return { deleted: true, label_id: id };
    },
  };
}

// ─── Settings ───────────────────────────────────────────────────────────────

function settingsGet(name: string, title: string, path: string, description: string): GoogleTool {
  return { name, title, description, inputSchema: schema({ user_id: USER_ID }), annotations: READ, run: (_args, ctx) => ctx.google.json({ url: `${G}/settings/${path}` }) };
}

function settingsPut(name: string, title: string, path: string, description: string, fields: Record<string, string>, props: Record<string, Record<string, unknown>>): GoogleTool {
  return {
    name,
    title,
    description,
    inputSchema: schema({ ...props, user_id: USER_ID }),
    annotations: { ...WRITE, idempotentHint: true },
    async run(args, ctx) {
      const current = await ctx.google.json<Json>({ url: `${G}/settings/${path}` });
      const body: Json = { ...current };
      for (const [arg, field] of Object.entries(fields)) if (args[arg] !== undefined) body[field] = args[arg];
      return ctx.google.json({ method: 'PUT', url: `${G}/settings/${path}`, body });
    },
  };
}

const SEND_AS_PROPS = {
  send_as_email: s('The send-as address.'),
  display_name: s('Name shown as the sender.'),
  reply_to_address: s('Reply-To address.'),
  signature: s('HTML signature.'),
  is_default: b('Make it the default From address.'),
  treat_as_alias: b('Treat as an alias of the account.'),
  smtp_msa: anyObj('SMTP relay settings.'),
  user_id: USER_ID,
};

function sendAsUpdate(name: string, method: 'PATCH' | 'PUT'): GoogleTool {
  return {
    name,
    title: 'Update send-as address',
    description: 'Change a send-as address: its display name, Reply-To, signature or default flag.',
    inputSchema: schema(SEND_AS_PROPS, ['send_as_email']),
    annotations: { ...WRITE, idempotentHint: true },
    async run(args, ctx) {
      const email = reqStr(args, 'send_as_email');
      const fields: Record<string, string> = { display_name: 'displayName', reply_to_address: 'replyToAddress', signature: 'signature', is_default: 'isDefault', treat_as_alias: 'treatAsAlias', smtp_msa: 'smtpMsa' };
      const body: Json = method === 'PUT' ? { ...(await ctx.google.json<Json>({ url: `${G}/settings/sendAs/${encodeURIComponent(email)}` })) } : {};
      for (const [arg, field] of Object.entries(fields)) if (args[arg] !== undefined) body[field] = args[arg];
      return ctx.google.json({ method, url: `${G}/settings/sendAs/${encodeURIComponent(email)}`, body });
    },
  };
}

const listFilters = settingsGet('list_filters', 'List filters', 'filters', 'List the mail filters.');
const listForwardingAddresses = settingsGet('list_forwarding_addresses', 'List forwarding addresses', 'forwardingAddresses', 'List forwarding addresses.');
const listSendAs = settingsGet('list_send_as', 'List send-as addresses', 'sendAs', 'List the addresses this account can send as, with signatures.');

const getFilter: GoogleTool = {
  name: 'get_filter',
  title: 'Get filter',
  description: 'One mail filter: its criteria and action.',
  inputSchema: schema({ id: s('Filter id.'), user_id: USER_ID }, ['id']),
  annotations: READ,
  run: (args, ctx) => ctx.google.json({ url: `${G}/settings/filters/${encodeURIComponent(reqStr(args, 'id', 'filter_id'))}` }),
};

const createFilter: GoogleTool = {
  name: 'create_filter',
  title: 'Create filter',
  description: 'Create a mail filter, such as criteria {from: "x@y.com"} and action {addLabelIds: ["Label_1"], removeLabelIds: ["INBOX"]}.',
  inputSchema: schema({ criteria: anyObj('from, to, subject, query, negatedQuery, hasAttachment, size, sizeComparison.'), action: anyObj('addLabelIds, removeLabelIds, forward.'), user_id: USER_ID }, ['criteria', 'action']),
  annotations: WRITE,
  run(args, ctx) {
    const criteria = optObj(args, 'criteria');
    const action = optObj(args, 'action');
    if (!criteria || !action) throw new ToolInputError('criteria and action are required objects');
    return ctx.google.json({ method: 'POST', url: `${G}/settings/filters`, body: { criteria, action } });
  },
};

const deleteFilter: GoogleTool = {
  name: 'delete_filter',
  title: 'Delete filter',
  description: 'Delete a mail filter.',
  inputSchema: schema({ filter_id: s('Filter id.'), user_id: USER_ID }, ['filter_id']),
  annotations: DESTRUCTIVE,
  async run(args, ctx) {
    const id = reqStr(args, 'filter_id', 'id');
    await ctx.google.json({ method: 'DELETE', url: `${G}/settings/filters/${encodeURIComponent(id)}` });
    return { deleted: true, filter_id: id };
  },
};

const settingsSendAsGet: GoogleTool = {
  name: 'settings_send_as_get',
  title: 'Get send-as address',
  description: 'One send-as address with its signature and settings.',
  inputSchema: schema({ send_as_email: s('The send-as address.'), user_id: USER_ID }, ['send_as_email']),
  annotations: READ,
  run: (args, ctx) => ctx.google.json({ url: `${G}/settings/sendAs/${encodeURIComponent(reqStr(args, 'send_as_email'))}` }),
};

const listSmimeInfo: GoogleTool = {
  name: 'list_smime_info',
  title: 'List S/MIME configs',
  description: 'List the S/MIME configs of a send-as address (Workspace with S/MIME only).',
  inputSchema: schema({ send_as_email: s('The send-as address.'), user_id: USER_ID }, ['send_as_email']),
  annotations: READ,
  run: (args, ctx) => ctx.google.json({ url: `${G}/settings/sendAs/${encodeURIComponent(reqStr(args, 'send_as_email'))}/smimeInfo` }),
};

function cseList(name: string, title: string, path: string): GoogleTool {
  return {
    name,
    title,
    description: `${title} (Workspace client-side encryption only).`,
    inputSchema: schema({ page_size: i('Items per page.'), page_token: s('nextPageToken of the previous page.'), user_id: USER_ID }),
    annotations: READ,
    run: (args, ctx) => ctx.google.json({ url: `${G}/settings/cse/${path}`, query: { pageSize: optInt(args, 'page_size'), pageToken: optStr(args, 'page_token', 'pageToken') } }),
  };
}

// ─── Raw message import, watch ──────────────────────────────────────────────

/** `raw` as base64url; plain RFC 5322 text is encoded first. */
function rawArg(args: Json): string {
  const raw = reqStr(args, 'raw');
  return /\r?\n/.test(raw) && /^[\x20-\x7e]+:/m.test(raw) ? encodeBase64Url(raw) : raw;
}

const importMessage: GoogleTool = {
  name: 'import_message',
  title: 'Import email',
  description: 'Import an RFC 5322 email into the mailbox, as if Gmail received it (spam checks run).',
  inputSchema: schema(
    {
      raw: s('The email as base64url, or as RFC 5322 text.'),
      internal_date_source: s('dateHeader (default) or receivedTime.'),
      never_mark_spam: b('Never mark it as spam.'),
      process_for_calendar: b('Process calendar invitations in it.'),
      deleted: b('Import it as deleted (Vault only).'),
      user_id: USER_ID,
    },
    ['raw'],
  ),
  annotations: WRITE,
  run: (args, ctx) =>
    ctx.google.json({
      method: 'POST',
      url: `${G}/messages/import`,
      query: {
        internalDateSource: optStr(args, 'internal_date_source'),
        neverMarkSpam: args.never_mark_spam,
        processForCalendar: args.process_for_calendar,
        deleted: args.deleted,
      },
      body: { raw: rawArg(args) },
    }),
};

const insertMessage: GoogleTool = {
  name: 'insert_message',
  title: 'Insert email',
  description: 'Insert an RFC 5322 email into the mailbox directly, with no scanning or sending.',
  inputSchema: schema({ raw: s('The email as base64url, or as RFC 5322 text.'), internalDateSource: s('receivedTime (default) or dateHeader.'), deleted: b('Insert it as deleted (Vault only).'), user_id: USER_ID }, ['raw']),
  annotations: WRITE,
  run: (args, ctx) =>
    ctx.google.json({ method: 'POST', url: `${G}/messages`, query: { internalDateSource: optStr(args, 'internalDateSource', 'internal_date_source'), deleted: args.deleted }, body: { raw: rawArg(args) } }),
};

const stopWatch: GoogleTool = {
  name: 'stop_watch',
  title: 'Stop push notifications',
  description: 'Stop the Gmail push notifications (users.watch) of this mailbox.',
  inputSchema: schema({ user_id: USER_ID }),
  annotations: DESTRUCTIVE,
  async run(_args, ctx) {
    await ctx.google.json({ method: 'POST', url: `${G}/stop` });
    return { stopped: true };
  },
};

// ─── People ─────────────────────────────────────────────────────────────────

const getContacts: GoogleTool = {
  name: 'get_contacts',
  title: 'List contacts',
  description: 'List the account\'s Google Contacts. include_other_contacts adds people the account emailed.',
  inputSchema: schema({
    resource_name: s('people/me (default).'),
    person_fields: s(`Fields to return, comma-separated. Default ${DEFAULT_PERSON_FIELDS}.`),
    page_token: s('nextPageToken of the previous page.'),
    include_other_contacts: b('Also list "Other contacts".', { default: false }),
  }),
  annotations: READ,
  async run(args, ctx) {
    const personFields = optStr(args, 'person_fields') ?? DEFAULT_PERSON_FIELDS;
    const connections = await ctx.google.json<Json>({
      url: `${PEOPLE}/${optStr(args, 'resource_name') ?? 'people/me'}/connections`,
      query: { personFields, pageSize: 1000, pageToken: optStr(args, 'page_token', 'pageToken') },
    });
    if (!optBool(args, 'include_other_contacts', false)) return connections;
    const others = await ctx.google.json<Json>({ url: `${PEOPLE}/otherContacts`, query: { readMask: 'names,emailAddresses,phoneNumbers', pageSize: 1000 } });
    return { ...connections, otherContacts: others?.otherContacts ?? [] };
  },
};

const getPeople: GoogleTool = {
  name: 'get_people',
  title: 'Get person',
  description: 'One person (resource_name, people/me by default), or with other_contacts the "Other contacts" list.',
  inputSchema: schema({
    resource_name: s('people/me or people/<id>.', { default: 'people/me' }),
    person_fields: s(`Fields to return. Default ${DEFAULT_PERSON_FIELDS}.`),
    other_contacts: b('List "Other contacts" instead.', { default: false }),
    page_size: i('Items per page for other_contacts.'),
    page_token: s('nextPageToken of the previous page.'),
    sources: strs('Sources, such as READ_SOURCE_TYPE_CONTACT.'),
    sync_token: s('Sync token for incremental reads.'),
  }),
  annotations: READ,
  run(args, ctx) {
    const fields = optStr(args, 'person_fields') ?? DEFAULT_PERSON_FIELDS;
    if (optBool(args, 'other_contacts', false)) {
      return ctx.google.json({
        url: `${PEOPLE}/otherContacts`,
        query: { readMask: fields, pageSize: optInt(args, 'page_size', 100, 1000), pageToken: optStr(args, 'page_token', 'pageToken'), syncToken: optStr(args, 'sync_token'), sources: strList(args, 'sources') },
      });
    }
    return ctx.google.json({ url: `${PEOPLE}/${optStr(args, 'resource_name') ?? 'people/me'}`, query: { personFields: fields, sources: strList(args, 'sources') } });
  },
};

const searchPeople: GoogleTool = {
  name: 'search_people',
  title: 'Search contacts',
  description: 'Find people by name, email or phone in Google Contacts, and with other_contacts in people the account emailed.',
  inputSchema: schema(
    { query: s('Name, email or phone prefix.'), other_contacts: b('Also search "Other contacts".', { default: true }), page_size: i('Results, up to 30.', { default: 10 }), person_fields: s(`Fields to return. Default ${DEFAULT_PERSON_FIELDS}.`) },
    ['query'],
  ),
  annotations: READ,
  async run(args, ctx) {
    const query = reqStr(args, 'query');
    const pageSize = optInt(args, 'page_size', 10, 30);
    const readMask = optStr(args, 'person_fields') ?? DEFAULT_PERSON_FIELDS;
    const contacts = await ctx.google.json<{ results?: unknown[] }>({ url: `${PEOPLE}/people:searchContacts`, query: { query, pageSize, readMask } });
    if (!optBool(args, 'other_contacts', true)) return { results: contacts?.results ?? [] };
    const others = await ctx.google
      .json<{ results?: unknown[] }>({ url: `${PEOPLE}/otherContacts:search`, query: { query, pageSize, readMask: 'names,emailAddresses,phoneNumbers' } })
      .catch(() => null);
    return { results: [...(contacts?.results ?? []), ...(others?.results ?? [])] };
  },
};

export const GMAIL_TOOLS: readonly GoogleTool[] = [
  fetchEmails,
  fetchMessageByMessageId,
  fetchMessageByThreadId,
  listMessages,
  listThreads,
  getAttachment,
  getProfile,
  whoAmI,
  listHistory,
  sendEmail,
  replyToThread,
  forwardMessage,
  createEmailDraft,
  updateDraft,
  listDrafts,
  getDraft,
  sendDraft,
  deleteDraft,
  addLabelToEmail,
  modifyThreadLabels,
  batchModifyMessages,
  trashTool('move_to_trash', 'Trash email', 'messages', 'message_id', 'trash'),
  trashTool('untrash_message', 'Restore email', 'messages', 'message_id', 'untrash'),
  trashTool('move_thread_to_trash', 'Trash thread', 'threads', 'thread_id', 'trash'),
  trashTool('untrash_thread', 'Restore thread', 'threads', 'thread_id', 'untrash'),
  trashTool('delete_message', 'Delete email', 'messages', 'message_id', 'trash', TRASH_NOTE),
  trashTool('delete_thread', 'Delete thread', 'threads', 'id', 'trash', TRASH_NOTE),
  batchDeleteMessages,
  listLabels,
  getLabel,
  createLabel,
  labelUpdate('patch_label', 'PATCH'),
  labelUpdate('update_label', 'PUT'),
  labelDelete('delete_label', false),
  labelDelete('remove_label', true),
  listFilters,
  getFilter,
  createFilter,
  deleteFilter,
  settingsGet('get_vacation_settings', 'Get vacation responder', 'vacation', 'The vacation auto-reply settings.'),
  settingsPut(
    'update_vacation_settings',
    'Set vacation responder',
    'vacation',
    'Turn the vacation auto-reply on or off and set its text and dates (startTime/endTime in epoch ms).',
    { enableAutoReply: 'enableAutoReply', responseSubject: 'responseSubject', responseBodyPlainText: 'responseBodyPlainText', responseBodyHtml: 'responseBodyHtml', restrictToContacts: 'restrictToContacts', restrictToDomain: 'restrictToDomain', startTime: 'startTime', endTime: 'endTime' },
    {
      enableAutoReply: b('Turn the auto-reply on.'),
      responseSubject: s('Subject of the auto-reply.'),
      responseBodyPlainText: s('Text of the auto-reply.'),
      responseBodyHtml: s('HTML of the auto-reply.'),
      restrictToContacts: b('Reply only to contacts.'),
      restrictToDomain: b('Reply only within the domain.'),
      startTime: s('Start, epoch milliseconds.'),
      endTime: s('End, epoch milliseconds.'),
    },
  ),
  settingsGet('get_auto_forwarding', 'Get auto-forwarding', 'autoForwarding', 'The auto-forwarding setting.'),
  settingsGet('get_language_settings', 'Get language', 'language', 'The Gmail display language.'),
  settingsPut('update_language_settings', 'Set language', 'language', 'Set the Gmail display language, such as en or de.', { display_language: 'displayLanguage' }, { display_language: s('Language tag, such as en-GB.') }),
  settingsGet('settings_get_imap', 'Get IMAP settings', 'imap', 'The IMAP settings.'),
  settingsGet('settings_get_pop', 'Get POP settings', 'pop', 'The POP settings.'),
  settingsPut(
    'update_imap_settings',
    'Set IMAP settings',
    'imap',
    'Turn IMAP on or off and set its expunge behavior.',
    { enabled: 'enabled', autoExpunge: 'autoExpunge', expungeBehavior: 'expungeBehavior', maxFolderSize: 'maxFolderSize' },
    { enabled: b('IMAP on.'), autoExpunge: b('Expunge immediately.'), expungeBehavior: s('archive, trash or deleteForever.'), maxFolderSize: i('Folder size limit, 0 for none.') },
  ),
  settingsPut(
    'update_pop_settings',
    'Set POP settings',
    'pop',
    'Set which mail POP serves and what happens after download.',
    { access_window: 'accessWindow', disposition: 'disposition' },
    { access_window: s('disabled, fromNowOn or allMail.'), disposition: s('leaveInInbox, archive, trash or markRead.') },
  ),
  listForwardingAddresses,
  listSendAs,
  settingsSendAsGet,
  sendAsUpdate('patch_send_as', 'PATCH'),
  sendAsUpdate('update_send_as', 'PUT'),
  listSmimeInfo,
  cseList('list_cse_identities', 'List CSE identities', 'identities'),
  cseList('list_cse_keypairs', 'List CSE key pairs', 'keypairs'),
  importMessage,
  insertMessage,
  stopWatch,
  getContacts,
  getPeople,
  searchPeople,
];
