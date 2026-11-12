/**
 * Pure logic of the `bash` tool row — a port of apps/web
 * `tool/tools/bash-tool.tsx` (the branches `BashTool` / `BashTrigger` /
 * `CommandBlock` take inline). The row-title and dedent rules live once in
 * `@kortix/shared/session/tool-row-text`; both hosts re-export them.
 *
 * The component (`components/session/tool/tools/bash-tool.tsx`) draws; every
 * decision it draws from lives here so `bun test` can pin it.
 */

import { shellExitCode, stripAnsi } from '@kortix/sdk';
import {
  formatBashOutput,
  hasStructuredContent,
  normalizeToolOutput,
  parseSessionMessagesOutput,
  parseSessionMetadataOutput,
  parseStructuredOutput,
  type OutputSection,
  type ParsedSessionMessage,
  type ParsedSessionMeta,
} from '@/lib/session/tool-output-parsers';
import { webSpace } from '@/lib/session/user-message';
import { dedentCommand } from '@kortix/shared/session/tool-row-text';

/** apps/web `hardcodedUi.i18nComplete` English strings the row uses. */
export const BASH_TEXT = {
  /** `text2afb17673ff9` */
  runningCommand: 'Running command',
  /** `textb93900bded31` */
  working: 'Working...',
  /** `textf7e31759b202` */
  noOutput: 'No output',
  /** `textccc6eb1c87a1` */
  exitCode: 'Exit code',
} as const;

/** The row-title and dedent rules live once in `@kortix/shared/session/tool-row-text`. */
export { bashRowTitle, dedentCommand } from '@kortix/shared/session/tool-row-text';

/** `input.command || metadata.command || streamingInput.command`, dedented. */
export function bashCommand(
  input: Record<string, unknown>,
  metadata: Record<string, unknown>,
  streamingInput: Record<string, unknown>,
): string {
  const raw =
    (input.command as string) || (metadata.command as string) || (streamingInput.command as string) || '';
  return dedentCommand(raw);
}

/** First line of the command and how many lines follow it (the trigger's `+N`). */
export function commandPreview(command: string): { commandPreview: string; extraLines: number } {
  const lines = command.split('\n');
  return { commandPreview: lines[0] || '', extraLines: lines.length - 1 };
}

/** The shell's exit code from the RAW output's `<exit_code>` tag; completed calls only. */
export function bashExitCode(state: { status: string; output?: string }): number | undefined {
  if (state.status !== 'completed') return undefined;
  return shellExitCode(state.output ?? '');
}

/** The card's exit-code strip text, or `null` when the command did not fail. */
export function bashExitLine(exitCode: number | undefined): string | null {
  if (typeof exitCode !== 'number' || exitCode === 0) return null;
  return `${BASH_TEXT.exitCode} ${exitCode}`;
}

export type BashTriggerContent =
  /** An input-less call from a turn that is over: static "Working..." text. */
  | { kind: 'stale'; label: string }
  /** Still running under a live stream. Open: the label shimmers, no command. */
  | { kind: 'live'; label: string; labelShimmers: boolean; preview: string | null }
  /** Settled (or orphaned). Open: the card spells the command, so the row drops it. */
  | { kind: 'settled'; title: string; failed: boolean; preview: string | null; extraLines: number }
  /** A live call whose command has not arrived: no trigger text. */
  | { kind: 'none' };

/** Web `BashTool` trigger + `BashTrigger`: which words the row draws. */
export function bashTriggerContent(args: {
  command: string;
  running: boolean;
  status: string;
  open: boolean;
  title: string;
  failed: boolean;
  commandPreview: string;
  extraLines: number;
}): BashTriggerContent {
  const { command, running, status, open } = args;
  const isStalePending = !command && !running && (status === 'pending' || status === 'running');
  if (isStalePending) return { kind: 'stale', label: BASH_TEXT.working };
  if (!args.commandPreview) return { kind: 'none' };
  const live = running && status !== 'completed' && status !== 'error';
  if (live) {
    return { kind: 'live', label: BASH_TEXT.runningCommand, labelShimmers: open, preview: open ? null : args.commandPreview };
  }
  return {
    kind: 'settled',
    title: args.title,
    failed: args.failed,
    preview: open ? null : args.commandPreview,
    extraLines: open ? 0 : args.extraLines,
  };
}

export type BashOutputView =
  | { kind: 'sessionMeta'; sessions: ParsedSessionMeta[] }
  | { kind: 'sessionMessages'; messages: ParsedSessionMessage[] }
  | { kind: 'structured'; sections: OutputSection[] }
  | { kind: 'plain'; text: string }
  | { kind: 'empty' };

/**
 * Web `BashTool` output selection, in its order: session metadata → session
 * messages → structured log sections → `formatBashOutput` plain text.
 * `output` is `partOutput(part)` (transport tags already stripped).
 */
export function bashOutputView(output: string): BashOutputView {
  const stripped = output ? stripAnsi(output) : '';
  if (!stripped) return { kind: 'empty' };
  const sessions = parseSessionMetadataOutput(stripped);
  if (sessions) return { kind: 'sessionMeta', sessions };
  const messages = parseSessionMessagesOutput(stripped);
  if (messages) return { kind: 'sessionMessages', messages };
  const normalized = normalizeToolOutput(stripped);
  if (hasStructuredContent(normalized)) return { kind: 'structured', sections: parseStructuredOutput(normalized) };
  const text = formatBashOutput(stripped).content;
  return text ? { kind: 'plain', text } : { kind: 'empty' };
}

/**
 * The output region under the command: `rich` / `plain` output, the "No
 * output" line once the call settled, or nothing while silence still means
 * "not yet".
 */
export function bashOutputRegion(view: BashOutputView, settled: boolean): 'rich' | 'plain' | 'empty' | null {
  if (view.kind === 'plain') return 'plain';
  if (view.kind !== 'empty') return 'rich';
  return settled ? 'empty' : null;
}

/** Web `max-h-64` (command) and `max-h-80` (output) — two scrollers, never one `max-h-96`. */
export const BASH_PANE = {
  commandMaxHeight: webSpace(64),
  outputMaxHeight: webSpace(80),
} as const;

/**
 * Web `paneInset = pad || 'py-2'` plus the `pr-11` copy reserve: inline takes
 * the full card pad; the panel keeps only the vertical 8px around the
 * command/output hairline.
 */
export function bashPaneInset(pad: number): { padding?: number; paddingVertical?: number; paddingRight: number } {
  return pad
    ? { padding: pad, paddingRight: webSpace(11) }
    : { paddingVertical: webSpace(2), paddingRight: webSpace(11) };
}
