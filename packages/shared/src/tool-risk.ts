/**
 * What a connector tool likely does, from its name alone: `read`, `write`,
 * or `unknown`. For grouping and rule templates only: the gateway enforces
 * the stored `risk` (MCP annotations, the HTTP method), never this guess.
 * Unknown is its own answer, never "write": a name that says nothing says
 * nothing.
 */
export type InferredToolRisk = 'read' | 'write' | 'unknown';

const READ = new Set(['get', 'list', 'read', 'search', 'fetch', 'find', 'query', 'describe', 'lookup']);
const WRITE = new Set(['create', 'update', 'delete', 'send', 'post', 'remove', 'archive', 'set', 'add']);

function verbRisk(word: string | undefined): InferredToolRisk {
  if (word && READ.has(word)) return 'read';
  if (word && WRITE.has(word)) return 'write';
  return 'unknown';
}

/**
 * The verb is the first word of the tool's last path segment, or the second
 * when the first is an app namespace (`GMAIL_FETCH_EMAILS`). Case, camelCase
 * and hyphens are ignored.
 */
export function inferToolRisk(name: string): InferredToolRisk {
  const last = name.split('.').pop() ?? '';
  const words = last
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[_\-\s]+/)
    .filter(Boolean);
  const first = verbRisk(words[0]);
  return first !== 'unknown' ? first : words.length > 2 ? verbRisk(words[1]) : 'unknown';
}

/**
 * The gate's risk for a tool whose source sends no risk annotation (Composio,
 * Pipedream): `read` or `write`, never `unknown`. Unlike `inferToolRisk`, the
 * gateway enforces this answer, so it is reviewed and fails closed:
 *
 *   1. The name starts with a read verb (`list_`, `get_`, `fetch_`, …; a
 *      namespace word before it counts, as in `GMAIL_LIST_LABELS`).
 *   2. No word of the name is a write verb (`get_or_create_label`,
 *      `search_and_replace` are writes).
 *   3. No word of the description is a write verb in its base or
 *      third-person form ("Sends", "modify"). Past participles and nouns
 *      ("user-created labels", "deleted messages", "posts") do not count.
 *
 * Anything else is `write`. Generic: no rule names an app.
 */
const READ_VERBS = new Set(['get', 'list', 'read', 'search', 'fetch', 'find', 'query', 'describe', 'lookup', 'retrieve', 'count']);

/** Verbs that change state. A name with any of them is a write wherever it sits. */
const WRITE_VERBS = [
  'accept', 'add', 'append', 'apply', 'approve', 'archive', 'assign', 'ban', 'block', 'call', 'cancel',
  'charge', 'clear', 'close', 'complete', 'copy', 'create', 'decline', 'delete', 'deny', 'disable',
  'dismiss', 'duplicate', 'edit', 'empty', 'enable', 'execute', 'follow', 'forward', 'generate',
  'import', 'insert', 'invite', 'invoke', 'issue', 'join', 'kick', 'leave', 'like', 'lock', 'mark',
  'merge', 'modify', 'move', 'mute', 'open', 'patch', 'pay', 'pin', 'post', 'publish', 'purge', 'put',
  'react', 'refund', 'register', 'reject', 'remove', 'rename', 'reply', 'reset', 'resolve', 'restore',
  'retweet', 'revoke', 'rotate', 'run', 'save', 'schedule', 'send', 'set', 'share', 'star', 'start',
  'stop', 'submit', 'subscribe', 'sync', 'tag', 'transfer', 'trash', 'trigger', 'unarchive', 'unassign',
  'unblock', 'unfollow', 'unlike', 'unlock', 'unmute', 'unpin', 'unstar', 'unsubscribe', 'untrash',
  'update', 'upload', 'upsert', 'vote', 'watch', 'write',
  'change', 'clone', 'deploy', 'destroy', 'drop', 'fork', 'grant', 'install', 'kill', 'overwrite', 'pause',
  'reboot', 'replace', 'restart', 'resume', 'suspend', 'terminate', 'uninstall',
];
/**
 * Write verbs that are also nouns in read names (`get_issue`, `get_post`,
 * `list_merge_requests`, `list_on_call_schedules`). They make a name a write
 * only as its first word, where no read verb stands.
 */
const NOUN_IN_NAMES = new Set([
  'block', 'call', 'change', 'charge', 'complete', 'copy', 'drop', 'empty', 'follow', 'fork', 'grant',
  'import', 'install', 'invite', 'issue', 'like', 'lock', 'merge', 'open', 'pin', 'post', 'react', 'refund',
  'register', 'reply', 'reset', 'resolve', 'resume', 'run', 'schedule', 'set', 'share', 'star', 'start',
  'stop', 'sync', 'tag', 'transfer', 'trigger', 'vote', 'watch',
]);
const WRITE_NAME_WORDS = new Set(WRITE_VERBS.filter((verb) => !NOUN_IN_NAMES.has(verb)));

/**
 * Description words that say the tool changes state: the third-person form of
 * each write verb ("Sends", "Modifies"), and the base form of the verbs that
 * are never nouns ("send", "modify"). Third-person forms that are also plural
 * nouns in read descriptions ("Retrieves posts", "Lists transfers") do not
 * count; the name check above still catches `create_post`.
 */
const UNAMBIGUOUS_BASE_VERBS = [
  'create', 'delete', 'destroy', 'edit', 'overwrite', 'replace', 'terminate', 'execute', 'insert', 'modify', 'publish', 'remove', 'rename', 'revoke',
  'send', 'submit', 'unsubscribe', 'update', 'upload', 'upsert', 'write',
];
const PLURAL_NOUNS = new Set([
  // Third-person forms that describe a read ("resolves names", "follows links").
  'applies', 'follows', 'resolves', 'starts', 'stops', 'calls', 'runs',
  'calls', 'changes', 'charges', 'copies', 'drops', 'forks', 'grants', 'installs', 'empties', 'imports', 'invites', 'issues', 'likes', 'locks', 'merges', 'opens',
  'patches', 'pins', 'posts', 'refunds', 'replies', 'runs', 'schedules', 'sets', 'shares', 'stars', 'starts',
  'tags', 'transfers', 'triggers', 'votes', 'watches',
]);
function thirdPerson(verb: string): string {
  if (/[^aeiou]y$/.test(verb)) return `${verb.slice(0, -1)}ies`;
  return /(s|sh|ch|x|z)$/.test(verb) ? `${verb}es` : `${verb}s`;
}
const WRITE_DESCRIPTION_WORDS = new Set([
  ...UNAMBIGUOUS_BASE_VERBS,
  ...WRITE_VERBS.map(thirdPerson).filter((word) => !PLURAL_NOUNS.has(word)),
]);

function words(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

export function classifyUnannotatedToolRisk(name: string, description = ''): 'read' | 'write' {
  const nameWords = words(name.split('.').pop() ?? '');
  const readVerb = READ_VERBS.has(nameWords[0] ?? '') || (nameWords.length > 2 && READ_VERBS.has(nameWords[1] ?? ''));
  if (!readVerb) return 'write';
  if (nameWords.some((word) => WRITE_NAME_WORDS.has(word))) return 'write';
  if (words(description).some((word) => WRITE_DESCRIPTION_WORDS.has(word))) return 'write';
  return 'read';
}
