/**
 * `restoreStrippedToolParts`: a tool call an old v1 mirror row stored without its input (before
 * 2026-09-28, backfilled into the session log) gets back the input its title and metadata prove.
 * `GET …/log` serves such a call with it (`withKeptToolInputs`, `session-log-read.ts`).
 */

import { isRecord } from '@kortix/shared/guards';

/** Same normalization as the SDK's `normalizeActivityToolName`. */
const normalizeToolName = (name: unknown) =>
  (typeof name === 'string' ? name : '').replace(/^oc-/, '').replace(/-/g, '_');

/** A tool call that has ended. The v1 wire schema gives both a required `input`. */
const isSettledToolStatus = (status: unknown) => status === 'completed' || status === 'error';

const SKILL_TITLE = 'Loaded skill: ';
const isUrl = (value: string) => /^https?:\/\//.test(value) && !/\s/.test(value);
const filePathInput = (absolute: unknown, title: string) =>
  typeof absolute === 'string' && absolute ? { filePath: absolute } : title ? { filePath: title } : null;

/**
 * The input a stripped call's kept `title` and `metadata` prove, per tool, as
 * OpenCode 1.17.11 to 1.18.23 writes them (`packages/opencode/src/tool/*.ts`).
 * The old mirror ran against no other version, so this table never changes.
 */
const STRIPPED_CALL_INPUT = new Map<
  string,
  (title: string, metadata: Record<string, unknown>) => Record<string, unknown> | null
>([
  // shell.ts: `title: input.command`.
  ['bash', (title) => (title ? { command: title } : null)],
  // read.ts: the title is the path relative to the worktree; `display.path` is absolute.
  ['read', (title, metadata) => filePathInput(isRecord(metadata.display) ? metadata.display.path : undefined, title)],
  // edit.ts: `filediff.file` is the absolute path.
  ['edit', (title, metadata) => filePathInput(isRecord(metadata.filediff) ? metadata.filediff.file : undefined, title)],
  // write.ts: `metadata.filepath` is the absolute path.
  ['write', (title, metadata) => filePathInput(metadata.filepath, title)],
  // grep.ts: `title: params.pattern`.
  ['grep', (title) => (title ? { pattern: title } : null)],
  // glob.ts: the title is the searched directory, relative to the worktree.
  ['glob', (title) => (title ? { path: title } : null)],
  // task.ts: `title: params.description`.
  ['task', (title) => (title ? { description: title } : null)],
  // webfetch.ts: `title: `${params.url} (${contentType})``.
  [
    'webfetch',
    (title) => {
      const cut = title.lastIndexOf(' (');
      const url = cut > 0 && title.endsWith(')') ? title.slice(0, cut) : '';
      return isUrl(url) ? { url } : null;
    },
  ],
  // todo.ts: `metadata.todos` is `params.todos`.
  ['todowrite', (_title, metadata) => (Array.isArray(metadata.todos) ? { todos: metadata.todos } : null)],
  // skill.ts: `title: `Loaded skill: ${info.name}``.
  [
    'skill',
    (title) =>
      title.startsWith(SKILL_TITLE) && title.length > SKILL_TITLE.length
        ? { name: title.slice(SKILL_TITLE.length) }
        : null,
  ],
]);

/**
 * Pure: a part array as a read serves it. Each tool call the old mirror
 * stripped gets back the input its kept `title` and `metadata` prove (see
 * `STRIPPED_CALL_INPUT`), and a completed command gets back its output from
 * `metadata.output` (shell.ts: the output's last 30,000 characters). A client
 * then draws the call with its own renderer instead of an empty row.
 *
 * Nothing is invented: a call that proves no input is served as stored.
 */
export function restoreStrippedToolParts(
  parts: ReadonlyArray<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  return parts.map((part) => {
    if (!isRecord(part) || part.type !== 'tool' || !isRecord(part.state)) return part;
    const state = part.state;
    if (!isSettledToolStatus(state.status) || 'input' in state) return part;
    const tool = normalizeToolName(part.tool);
    const metadata = isRecord(state.metadata) ? state.metadata : {};
    const title = typeof state.title === 'string' ? state.title : '';
    const input = STRIPPED_CALL_INPUT.get(tool)?.(title, metadata);
    if (!input) return part;
    // An `error` state carries an error, never an output, and this row lost it.
    const output =
      tool === 'bash' && state.status === 'completed' && typeof metadata.output === 'string'
        ? { output: metadata.output }
        : {};
    return { ...part, state: { ...state, input, ...output } };
  });
}
