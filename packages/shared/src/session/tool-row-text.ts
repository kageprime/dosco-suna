/**
 * The pure text rules of the `bash` tool row. Both hosts
 * (`packages/ui/src/session/tool/tools/bash-tool.tsx`,
 * `apps/mobile/lib/session/tools/files-bash.ts`) re-export these, so every
 * fix lands once.
 */

/** The row title never runs past this; a trigger is one line, not a sentence. */
const TITLE_MAX = 60;

/**
 * The words a settled row leads with.
 *
 * The bash tool's input carries a `description` — the one-line summary the
 * model writes for its own call ("Install the workspace dependencies"). The
 * SDK already reads it as this tool's subtitle (`core/turns/parts.ts`, case
 * `'bash'`), so the row promotes a source it had been dropping rather than
 * inventing one. A reader scanning a turn wants to know what a command was
 * FOR, and `pnpm -w install --frozen-lockfile` answers that only if they read
 * shell.
 *
 * Three rules, in order:
 * - A failure keeps its verdict. "Command failed" is the one thing a friendly
 *   summary must never soften, so it outranks any description.
 * - No description → exactly today's "Ran command". Nothing is ever derived
 *   from the command text: a classifier answering "Installed dependencies" to
 *   `npm i` would put a claim in the model's mouth that it never made.
 * - Sentence case only lifts a lower-case opener. Lowering the rest would turn
 *   "Run CI on the release branch" into "Run ci on the release branch".
 */
export function bashRowTitle(description: unknown, failed: boolean): string {
  if (failed) return 'Command failed';

  // Collapsed, because a description arrives as free text and may carry a
  // newline; a trigger row renders it on one line either way.
  const summary = typeof description === 'string' ? description.replace(/\s+/g, ' ').trim() : '';
  if (!summary) return 'Ran command';

  const cased = /^[a-z]/.test(summary) ? summary[0].toUpperCase() + summary.slice(1) : summary;
  if (cased.length <= TITLE_MAX) return cased;
  // Trim the tail before the ellipsis. `truncate` in `lib/utils/string` cuts on
  // the character count alone, which strands a space in front of the ellipsis
  // whenever the cut lands just after a word.
  return `${cased.slice(0, TITLE_MAX).trimEnd()}…`;
}

/**
 * The command as the reader should see it: leading indent stripped, blank
 * edges dropped.
 *
 * Commands arrive with incidental leading whitespace — a model quoting a
 * command out of indented YAML/JSON sends `  agent-browser open …`. The
 * trigger row hides it (a `truncate` span collapses spaces under normal
 * white-space), but the card's `whitespace-pre-wrap` pane renders it verbatim,
 * so the first line sits two characters deeper than its own wrapped
 * continuation and the output below — an inverse hanging indent that reads as
 * broken padding.
 *
 * Two rules, because a one-line command and a script are different documents:
 *
 * - **One line has no structure to protect**, so every leading blank is noise
 *   and all of it goes. This is the case a common-indent rule cannot be
 *   trusted with alone: it only strips what it can MEASURE, and the measure
 *   used to be `[ \t]` — so a command indented with a non-breaking space (or
 *   any other Unicode space; agents paste these out of rendered docs and
 *   spreadsheets) kept its indent and drew exactly the misalignment above.
 * - **A script keeps its shape**: the COMMON indent goes, never a per-line
 *   trim, so nesting survives. Heredocs survive by construction — a non-`<<-`
 *   heredoc needs its terminator at column 0, which pins the common indent to
 *   0 and makes this a no-op exactly where indentation is load-bearing.
 *
 * `[^\S\r\n]` is "whitespace that is not a line break", so both rules count
 * every horizontal space character the Unicode table has, not just the two on
 * a US keyboard. The trailing trim also stops a final `\n` from counting as a
 * phantom `+1` line in the trigger.
 */
export function dedentCommand(raw: string): string {
  const text = raw.replace(/^[\r\n]+/, '').trimEnd();
  if (!text) return '';
  const lines = text.split('\n');
  // One line: strip the lot. `trimEnd` above already took the other end.
  if (lines.length === 1) return lines[0].replace(/^[^\S\r\n]+/, '');
  let min = Infinity;
  for (const line of lines) {
    if (!line.trim()) continue;
    min = Math.min(min, /^[^\S\r\n]*/.exec(line)![0].length);
  }
  if (!min || min === Infinity) return text;
  return lines.map((line) => line.slice(min)).join('\n');
}
