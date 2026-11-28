/**
 * A thread as text to copy: plain text, Markdown, or JSON. Only what a person
 * reads: each message's author, time and words. Tool calls, reasoning and
 * system notices (`synthetic` text) stay out.
 */

interface ExportPart {
  type?: string;
  text?: string;
  synthetic?: boolean;
}

export interface ExportMessage {
  info: { role?: string; time?: { created?: number } };
  parts: readonly unknown[];
}

export interface ThreadExportEntry {
  role: 'person' | 'agent';
  author: string;
  created_at: string | null;
  text: string;
}

function messageText(parts: readonly unknown[]): string {
  return parts
    .map((part) => part as ExportPart)
    .filter((part) => part.type === 'text' && !part.synthetic && typeof part.text === 'string')
    .map((part) => part.text!.trim())
    .filter(Boolean)
    .join('\n\n');
}

/** The thread's messages with words in them, oldest first. */
export function threadEntries(
  messages: readonly ExportMessage[],
  names: { person: string; agent: string },
): ThreadExportEntry[] {
  return messages
    .map((message) => {
      const role: ThreadExportEntry['role'] = message.info.role === 'user' ? 'person' : 'agent';
      const created = message.info.time?.created;
      return {
        role,
        author: role === 'person' ? names.person : names.agent,
        created_at: typeof created === 'number' ? new Date(created).toISOString() : null,
        text: messageText(message.parts),
      };
    })
    .filter((entry) => entry.text !== '');
}

/** "Name: words", one message per block. */
export function threadAsText(entries: readonly ThreadExportEntry[]): string {
  return entries.map((entry) => `${entry.author}: ${entry.text}`).join('\n\n');
}

/** A heading per message with its time, the words as written. */
export function threadAsMarkdown(entries: readonly ThreadExportEntry[], title: string): string {
  const body = entries.map((entry) => `**${entry.author}**${entry.created_at ? ` · ${entry.created_at}` : ''}\n\n${entry.text}`);
  return [`# ${title}`, ...body].join('\n\n');
}

export function threadAsJson(entries: readonly ThreadExportEntry[], meta: { sessionId: string; title: string }): string {
  return JSON.stringify({ session_id: meta.sessionId, title: meta.title, messages: entries }, null, 2);
}
