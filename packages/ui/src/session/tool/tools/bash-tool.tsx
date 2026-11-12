'use client';

import { HighlightedCode } from '../../../markdown/code';
import { TextShimmer } from '../../../primitives/text-shimmer';
import {
  BasicTool,
  partInput,
  partMetadata,
  partOutput,
  partStatus,
  partStreamingInput,
  StructuredOutput,
  RecoveredCallsContext,
  ToolRunningContext,
  useToolCardFrame,
  useToolCardPad,
  useToolIndent,
  useToolOpen,
  partRawOutput,
} from '../shared/infrastructure';
import { GenericTool } from '../generic-tool';
import { ToolRegistry } from '../shared/registry';
import type { ToolProps } from '../shared/types';
import { cn } from '../../../lib/utils';
import { useTranslations } from '../../../i18n';

import { CopyButton } from '../../../markdown/copy-button';
import {
  formatBashOutput,
  InlineSessionMessagesList,
  parseSessionMessagesOutput,
  parseSessionMetadataOutput,
  SessionMetadataList,
} from '../shared/session-helpers';
import {
  hasStructuredContent,
  normalizeToolOutput,
  parseStructuredOutput,
} from '../../../internal/lib/utils/structured-output';
import { shellExitCode, stripAnsi } from '../../../internal/session-types';
import { bashRowTitle, dedentCommand } from '@kortix/shared/session/tool-row-text';
import { TerminalIcon } from '@phosphor-icons/react';
import { toolKind } from '@kortix/sdk';
import { useContext, useMemo } from 'react';
import { ChannelBrandMark } from '../../turn/channel-brand';
import { channelSendText, parseChannelSendCommand } from './channel-send';
import { ChannelSendCard, channelSendTitle } from './channel-send-card';

/** The row-title and dedent rules live once in `@kortix/shared/session/tool-row-text`. */
export { bashRowTitle, dedentCommand };

/**
 * The command, syntax-highlighted, with its output beneath a hairline.
 *
 * Replaces a simulated `kortix@host:~$` prompt. The prompt dressed the command
 * up as a live shell it never was, spent the first third of every line on a
 * hostname the reader cannot act on, and — being plain text — gave a
 * multi-line pipeline no structure at all. Highlighting spends that space on
 * the command instead, so a `curl … | python3 -c "…"` reads as the two stages
 * it is.
 *
 * The command pane carries the same `bg-muted/40` wash the service-preview
 * header uses, so what was typed and what came back read as two zones without
 * a word of labelling — the tint says "invocation", the plain surface below
 * says "result". Inline only: on the panel the card has no frame to clip the
 * tint against, and a square tinted block floating inside the row body's
 * `px-3` gutter reads as a highlight, not a header.
 *
 * One frame, one type rhythm: `border bg-popover rounded-md` around content
 * panes that share a 12px inset and one `leading-relaxed` line height. That
 * pairing — `[&_code]:text-xs [&_code]:leading-relaxed` over a 12px pane — is
 * the same override `iam/audit-tab.tsx` uses to pull `HighlightedCode` down to
 * a small pane: the component hardcodes `text-sm leading-[1.65]` on its own
 * `<code>`, and a `[&_code]:` variant is one specificity step above it. The
 * size half was already here; without the leading half the highlighted command
 * kept a line height 0.3px off the output it sits above.
 *
 * That frame is the INLINE surface's. On the panel the frame and the
 * horizontal inset both belong to the row card this hangs inside
 * (`useToolCardFrame`), so only the vertical air around the command/output
 * hairline survives.
 *
 * The empty state takes that leading too, so a command that printed nothing
 * stands exactly where one line of output would instead of collapsing 3.5px
 * shorter than the region it speaks for (`text-xs` alone is a flat 16px line).
 * The exit-code strip keeps its shorter 8px vertical inset: it is metadata
 * about the card, not a third pane of content.
 */
function CommandBlock({
  command,
  output,
  richOutput,
  exitCode,
  settled,
}: {
  command: string;
  output: string;
  richOutput: React.ReactNode;
  exitCode?: number;
  /** The call has finished. Until it has, silence means "not yet", not "none". */
  settled: boolean;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const hasOutput = Boolean(richOutput || output);
  const failed = typeof exitCode === 'number' && exitCode !== 0;
  // On the panel the row card is the frame and the disclosure body is the
  // inset, so this card draws neither — the gate counted FOUR seams around one
  // bash payload. The command/output hairline below is not one of them: it
  // separates two different things and stays on both surfaces.
  const frame = useToolCardFrame();
  const pad = useToolCardPad();
  // The one part of the card's inset the panel still needs. Horizontally the
  // row body's `px-3` is the gutter, but the hairline BETWEEN the command and
  // its output is internal to this card, and text pressed against it on both
  // sides is worse than the extra frame ever was.
  const paneInset = pad || 'py-2';

  return (
    // `overflow-hidden` clips the command pane's tint to the rounded frame;
    // without it the wash pokes square corners past `rounded-md`.
    <div className={cn('relative overflow-hidden', frame)}>
      {/* The tint rides the scroller, not a wrapper, so no `class="relative"`
          div lands between the card and `max-h-64` — the geometry tests locate
          the card by exactly that prefix. */}
      <div data-scrollable className={cn('max-h-64 overflow-auto', frame && 'bg-muted/40')}>
        <pre
          className={cn(
            'text-foreground font-mono text-xs leading-relaxed wrap-break-word whitespace-pre-wrap [&_code]:border-none [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-xs [&_code]:leading-relaxed [&_code]:whitespace-pre-wrap [&_pre]:whitespace-pre-wrap [&_span]:border-none [&_span]:outline-none',
            paneInset,
            'pr-11',
          )}
        >
          <HighlightedCode code={command} language="bash">
            {command}
          </HighlightedCode>
        </pre>
      </div>
      {/* Anchored to the CARD, not to a wrapper inside the scroller — inside,
          it scrolled away with a long command while the output's stayed
          pinned. */}
      <div className="absolute top-2 right-2">
        <CopyButton code={command} className="text-muted-foreground hover:text-foreground" />
      </div>

      {(hasOutput || settled) && (
        <div className="border-border/60 border-t">
          {richOutput ? (
            richOutput
          ) : output ? (
            <div className="relative">
              <div data-scrollable className="max-h-80 overflow-auto">
                <div
                  className={cn(
                    'text-muted-foreground font-mono text-xs leading-relaxed wrap-break-word whitespace-pre-wrap',
                    paneInset,
                    'pr-11',
                  )}
                >
                  {output}
                </div>
              </div>
              <div className="absolute top-2 right-2">
                <CopyButton
                  code={output}
                  className="text-muted-foreground hover:text-foreground"
                />
              </div>
            </div>
          ) : (
            <p className={cn('text-muted-foreground', paneInset, 'text-xs leading-relaxed')}>
              {tI18nComplete.raw('textf7e31759b202')}
            </p>
          )}
        </div>
      )}

      {failed && (
        <div
          className={cn(
            // Muted ink, like the trigger's "Command failed": a failed command
            // is ordinary agent work (it reads the error and tries again), so
            // the words carry the verdict and no color raises an alarm.
            'border-border/60 border-t py-2 font-mono text-xs tabular-nums text-muted-foreground',
            // Metadata about the card, not a third pane: it keeps the shorter
            // 8px vertical inset, and only the horizontal one is the surface's
            // to supply.
            pad && 'px-3',
          )}
        >
          {tI18nComplete.raw('textccc6eb1c87a1')} {exitCode}
        </div>
      )}
    </div>
  );
}

/**
 * The words on the trigger row.
 *
 * Its own component, not inline JSX in {@link BashTool}, because
 * `useToolOpen()` only answers truthfully where the trigger is RENDERED —
 * inside `BasicTool`'s provider. Called from `BashTool`'s body it would read
 * the context default and never change.
 *
 * Open, the row drops the command. The card directly beneath is already
 * showing that exact text — highlighted, whole, with its own copy button — so
 * the trigger's one line was spending itself on the only thing the reader
 * cannot be missing, in a truncated copy that disagreed with the full one for
 * every command longer than the row. What survives is the part the card does
 * not repeat: the description, or the failure verdict.
 *
 * Closed, that line is the only evidence of what ran, so it stays exactly as
 * it was — preview, `+N` line count, and the full command as the native
 * tooltip.
 */
function BashTrigger({
  title,
  failed,
  command,
  commandPreview,
  extraLines,
  live,
}: {
  title: string;
  failed: boolean;
  command: string;
  commandPreview: string;
  extraLines: number;
  /** The call is still running under a live stream. */
  live: boolean;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const open = useToolOpen();

  if (live) {
    return (
      <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
        {open ? (
          // The shimmer moves to the label: mid-flight the row still has to
          // read as in-progress, and with the command gone there is nothing
          // else left on it to carry the motion.
          <TextShimmer duration={1} spread={2} className="min-w-0 truncate text-xs">
            {tI18nComplete.raw('text2afb17673ff9')}
          </TextShimmer>
        ) : (
          <>
            <span className="text-foreground shrink-0 text-xs">
              {tI18nComplete.raw('text2afb17673ff9')}
            </span>
            <TextShimmer
              duration={1}
              spread={2}
              className="text-muted-foreground min-w-0 truncate font-mono text-xs"
            >
              {commandPreview}
            </TextShimmer>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
      <span
        className="flex min-w-0 shrink-0 items-center gap-2 text-xs"
        // Redundant once the card spells the command out below.
        title={open ? undefined : command}
      >
        {/* `truncate`, not `shrink-0`: a description title is a sentence, and
            on a narrow row a rigid one would be clipped mid-word by the
            trigger's `overflow-hidden` instead of ending in an ellipsis. */}
        <span className="min-w-0 truncate text-foreground">
          {title}
        </span>
        {!open && (
          <>
            <span className="text-muted-foreground min-w-0 truncate font-mono">
              {commandPreview}
            </span>
            {extraLines > 0 && (
              <span className="text-muted-foreground shrink-0 tabular-nums">+{extraLines}</span>
            )}
          </>
        )}
      </span>
    </div>
  );
}

export function BashTool({ call, defaultOpen, forceOpen, locked }: ToolProps) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const input = partInput(call);
  const streamingInput = partStreamingInput(call);
  const metadata = partMetadata(call);
  const output = partOutput(call);
  const status = partStatus(call);
  const running = useContext(ToolRunningContext);
  const indent = useToolIndent();
  // Codex sends `cmd` (`exec_command`) or an argv array (`shell`).
  const rawCommand =
    (typeof input.command === 'string' && input.command) ||
    (Array.isArray(input.command) && input.command.join(' ')) ||
    (input.cmd as string) ||
    (metadata.command as string) ||
    (streamingInput.command as string) ||
    '';
  // Everything downstream — card, preview, line count, copy — shows the
  // dedented text, so the row and the pane can never disagree about where the
  // command starts. No manual memo: a command is a short string, and wrapping
  // this in `useMemo` made the React Compiler skip the whole component
  // (`preserve-manual-memoization`) — a far worse trade than re-splitting a
  // one-line string.
  const command = dedentCommand(rawCommand);
  const strippedOutput = useMemo(() => (output ? stripAnsi(output) : ''), [output]);

  const sessionMeta = useMemo(() => parseSessionMetadataOutput(strippedOutput), [strippedOutput]);

  const sessionMessages = useMemo(
    () => (sessionMeta ? null : parseSessionMessagesOutput(strippedOutput)),
    [strippedOutput, sessionMeta],
  );

  const structuredSections = useMemo(() => {
    if (sessionMeta || sessionMessages || !strippedOutput) return null;
    const normalized = normalizeToolOutput(strippedOutput);
    if (!hasStructuredContent(normalized)) return null;
    return parseStructuredOutput(normalized);
  }, [strippedOutput, sessionMeta, sessionMessages]);

  const plainOutput = useMemo(() => {
    if (!strippedOutput || sessionMeta || sessionMessages || structuredSections) return '';
    return formatBashOutput(strippedOutput).content;
  }, [strippedOutput, sessionMeta, sessionMessages, structuredSections]);

  const richOutput = sessionMeta ? (
    <SessionMetadataList sessions={sessionMeta} />
  ) : sessionMessages ? (
    <InlineSessionMessagesList messages={sessionMessages} />
  ) : structuredSections ? (
    <StructuredOutput sections={structuredSections} />
  ) : null;

  const isStalePending = !command && !running && (status === 'pending' || status === 'running');

  const exitCode = useMemo(() => {
    if (call.status !== 'complete') return undefined;
    // OpenCode tags the code in the output; pi records it beside the output (KRTX-3021).
    const recorded = partMetadata(call).exit;
    return shellExitCode(partRawOutput(call)) ?? (typeof recorded === 'number' ? recorded : undefined);
  }, [call]);
  const failed = typeof exitCode === 'number' && exitCode !== 0;
  // A failure the agent moved past keeps its words, not the red (KRTX-3021).
  const recovered = useContext(RecoveredCallsContext).has(call.id);

  // `teams send "…"` / `slack send …` / `telegram send …` IS the reply the
  // person in the channel received. It renders as that message — badge, text,
  // attachment — with the shell call kept underneath for the record. A failed
  // send stays a failed command: the reply never left.
  // No manual memo: the parser is a one-line scan, and a hand-written memo
  // here makes the React Compiler skip the whole component (see `command`).
  const send = failed ? null : parseChannelSendCommand(command);
  // Read before the memo below: a call on `send` after it makes the React
  // Compiler assume `command` can still change, and skip the component.
  const sendText = send ? channelSendText(send) : null;
  const title = send ? channelSendTitle(send.platform, tI18nComplete) : bashRowTitle(input.description, failed);

  const { commandPreview, extraLines } = useMemo(() => {
    const lines = command.split('\n');
    return { commandPreview: lines[0] || '', extraLines: lines.length - 1 };
  }, [command]);

  // A shell-kind call from another harness that carries no command (a Claude Code
  // `BashOutput`, a Codex `write_stdin`) has nothing for this row to draw: the generic row
  // shows its name, input and output.
  if (!command && toolKind(call.name) !== 'bash') {
    return <GenericTool call={call} defaultOpen={defaultOpen} forceOpen={forceOpen} locked={locked} />;
  }

  return (
    <BasicTool
      icon={
        send ? (
          <ChannelBrandMark platform={send.platform} className="size-4 shrink-0" />
        ) : (
          <TerminalIcon className="size-4 shrink-0" />
        )
      }
      trigger={
        isStalePending ? (
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            <TextShimmer duration={1} spread={2}>
              {tI18nComplete.raw('textb93900bded31')}
            </TextShimmer>
          </div>
        ) : commandPreview ? (
          <BashTrigger
            title={title}
            failed={failed && !recovered}
            command={command}
            commandPreview={send ? (sendText ?? send.file ?? '') : commandPreview}
            extraLines={send ? 0 : extraLines}
            live={running && status !== 'completed' && status !== 'error'}
          />
        ) : null
      }
      // The reply is the point of the row, so it opens showing it.
      defaultOpen={defaultOpen || Boolean(send)}
      forceOpen={forceOpen}
      locked={locked}
    >
      {send && (
        <div className={cn('mb-1.5', indent && 'mt-1.5', indent)}>
          <ChannelSendCard send={send} />
        </div>
      )}
      {command && (
        // `CommandBlock` is a bordered card like the shared three, so it takes
        // the same gate: the seam belongs to the inline row it hangs under, not
        // to the panel body that already supplies `px-3 py-3`.
        <div className={cn(indent && 'mt-1.5', indent)}>
          <CommandBlock
            command={command}
            output={plainOutput}
            richOutput={richOutput}
            exitCode={exitCode}
            settled={status === 'completed' || status === 'error'}
          />
        </div>
      )}
    </BasicTool>
  );
}
ToolRegistry.register('bash', BashTool);
