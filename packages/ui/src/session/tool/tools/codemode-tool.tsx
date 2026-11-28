'use client';

import { HighlightedCode } from '../../../markdown/code';
import { CopyButton } from '../../../markdown/copy-button';
import Loading from '../../../primitives/loading';
import { TextShimmer } from '../../../primitives/text-shimmer';
import {
  BasicTool,
  partError,
  partInput,
  partMetadata,
  partOutput,
  partStatus,
  ToolRunningContext,
  useToolCardFrame,
  useToolCardPad,
  useToolIndent,
  useToolOpen,
} from '../shared/infrastructure';
import { ToolRegistry } from '../shared/registry';
import type { ToolProps } from '../shared/types';
import { useTranslations } from '../../../i18n';
import { cn } from '../../../lib/utils';
import { getToolPrimaryArg, parseKortixToolResult } from '@kortix/sdk';
import { CheckIcon, CodeIcon, MinusIcon, ProhibitIcon, WarningIcon } from '@phosphor-icons/react';
import { useContext } from 'react';

/** One tool call a codemode script made. */
export interface ScriptCall {
  id: string;
  name: string;
  /** The call's main argument (a command, a path), else its arguments as compact JSON. */
  arg: string;
  /** `refused`: the runtime blocked the call by design (the project policy, a person's reject, a tool scripts may not call). */
  status: 'running' | 'ok' | 'error' | 'refused' | 'cancelled';
  durationMs?: number;
  error?: string;
}

const STATUS: Record<string, ScriptCall['status']> = {
  running: 'running',
  ok: 'ok',
  complete: 'ok',
  error: 'error',
  cancelled: 'cancelled',
  interrupted: 'cancelled',
};

/** The reasons the pi runtime blocks a call with (kortixd `pi/runtime.ts`: `decide`, `nestedCallGate`). */
const REFUSED = /^(The project policy denies|The user rejected|Call \S+ directly, not from a script)/;

function callArg(name: string, input: unknown): string {
  if (input === undefined || input === '') return '';
  // pi's live record sends the arguments as truncated JSON; it may not parse.
  let value = input;
  if (typeof input === 'string') {
    try {
      value = JSON.parse(input);
    } catch {
      return input;
    }
  }
  const primary =
    value && typeof value === 'object'
      ? getToolPrimaryArg({ type: 'tool', tool: name, state: { status: 'completed', input: value } } as never)
      : '';
  return primary || (typeof value === 'string' ? value : JSON.stringify(value));
}

/**
 * The calls a script made, from its tool metadata: pi's live record while it runs
 * (`id`, `args` as JSON text, `ok`/`cancelled`) or the session log's at rest
 * (`call_id`, `input`, `complete`/`interrupted`).
 */
export function scriptCalls(metadata: Record<string, unknown>): ScriptCall[] {
  const calls = Array.isArray(metadata.calls) ? (metadata.calls as Array<Record<string, unknown>>) : [];
  return calls.map((c) => ({
    id: String(c.id ?? c.call_id ?? ''),
    name: String(c.name ?? ''),
    arg: callArg(String(c.name ?? ''), c.args ?? c.input),
    status: STATUS[String(c.status)] === 'error' && typeof c.error === 'string' && REFUSED.test(c.error) ? 'refused' : (STATUS[String(c.status)] ?? 'cancelled'),
    ...(typeof (c.durationMs ?? c.duration_ms) === 'number' ? { durationMs: Number(c.durationMs ?? c.duration_ms) } : {}),
    ...(typeof c.error === 'string' && c.error ? { error: c.error } : {}),
  }));
}

/** The script's result without pi's `Script completed|failed`, `Wall time` and `Output:` header lines. */
export function scriptResult(text: string): string {
  return text.replace(/^Script (?:completed|failed)\n(?:Wall time [^\n]*\n)?(?:Output:\n)?/, '').trim();
}

/** One Kortix tool result a script printed: its card's title line and its rows. */
export interface ScriptCard {
  title: string;
  rows: string[];
}

/**
 * A script that returns Kortix tool results (`text(await tools.task_stop(…))`)
 * prints them as escaped JSON. Read each one as its card: the title ("faq-writer
 * had already ended") and every row under it, so a list keeps its entries.
 * Null when the output is anything else, or when a card carries a link or a
 * change the summary would drop.
 */
export function scriptCards(result: string): ScriptCard[] | null {
  let value: unknown;
  try {
    value = JSON.parse(result);
  } catch {
    return null;
  }
  const items = Array.isArray(value) ? value : [value];
  const cards: ScriptCard[] = [];
  for (const item of items) {
    const raw = typeof item === 'string' ? item : JSON.stringify(item);
    const parsed = parseKortixToolResult(raw);
    if (!parsed) return null;
    const { card } = parsed;
    // The parser caps a card's rows: a longer list keeps the original output, so no row is lost.
    if (rawRowCount(raw) !== card.rows.length) return null;
    // A link (a sign-in, a row's session URL) or a setting change is an action or
    // a fact the summary would drop: the original output stays.
    if (card.links.length > 0 || card.changes.length > 0 || card.rows.some((row) => row.href)) return null;
    cards.push({
      title: card.subtitle ? `${card.title} · ${card.subtitle}` : card.title,
      rows: card.rows.map((row) => [row.title, row.detail, row.badge].filter(Boolean).join(' · ')),
    });
  }
  return cards.length ? cards : null;
}

/** How many rows the card had before parsing. */
function rawRowCount(raw: string): number {
  try {
    const rows = (JSON.parse(raw) as { card?: { rows?: unknown } }).card?.rows;
    return Array.isArray(rows) ? rows.length : 0;
  } catch {
    return -1;
  }
}

/** The cards as plain text, for the copy button. */
export function scriptCardsText(cards: ScriptCard[]): string {
  return cards.map((card) => [card.title, ...card.rows.map((row) => `  ${row}`)].join('\n')).join('\n');
}

function formatDuration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function CallMark({ status }: { status: ScriptCall['status'] }) {
  if (status === 'running') return <Loading className="text-muted-foreground size-3 shrink-0" />;
  if (status === 'ok') return <CheckIcon className="text-kortix-green size-3 shrink-0" />;
  if (status === 'error') return <WarningIcon weight="fill" className="text-muted-foreground size-3 shrink-0" />;
  if (status === 'refused') return <ProhibitIcon weight="fill" className="text-kortix-orange size-3 shrink-0" />;
  return <MinusIcon className="text-muted-foreground size-3 shrink-0" />;
}

/**
 * The script's tool calls, one row each: what ran, its main argument, how long it took.
 * This list is what sets a script apart from every other tool row, so it sits first.
 * pi keeps no output per call; a failed call shows its error.
 */
function CallList({ calls }: { calls: ScriptCall[] }) {
  return (
    <ul className="space-y-1">
      {calls.map((call, index) => (
        <li key={call.id || index} className="text-xs leading-relaxed">
          <div className="flex min-w-0 items-center gap-2">
            <CallMark status={call.status} />
            <span className="text-foreground shrink-0 font-mono">{call.name}</span>
            <span className="text-muted-foreground min-w-0 flex-1 truncate font-mono" title={call.arg}>
              {call.arg}
            </span>
            {call.durationMs !== undefined && (
              <span className="text-muted-foreground shrink-0 tabular-nums">{formatDuration(call.durationMs)}</span>
            )}
          </div>
          {call.error && <p className="text-muted-foreground pl-5 font-mono wrap-break-word">{call.error}</p>}
        </li>
      ))}
    </ul>
  );
}

/** The row's words stay ink: the outcome mark `BasicTool` draws carries a failure's hue. */
function ScriptTrigger({ title, live, summary }: { title: string; live: boolean; summary: string }) {
  const open = useToolOpen();
  return (
    <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden text-xs">
      {live ? (
        <TextShimmer duration={1} spread={2} className="shrink-0 text-xs">
          {title}
        </TextShimmer>
      ) : (
        <span className="text-foreground shrink-0">{title}</span>
      )}
      {!open && summary && <span className="text-muted-foreground min-w-0 truncate">{summary}</span>}
    </div>
  );
}

export function CodemodeTool({ call, defaultOpen, forceOpen, locked }: ToolProps) {
  const t = useTranslations('tools.codemode');
  const running = useContext(ToolRunningContext);
  const frame = useToolCardFrame();
  const pad = useToolCardPad();
  const indent = useToolIndent();
  const paneInset = pad || 'py-2';

  const code = typeof partInput(call).code === 'string' ? (partInput(call).code as string).trim() : '';
  const calls = scriptCalls(partMetadata(call));
  const status = partStatus(call);
  const failed = status === 'error';
  const live = running && !failed && status !== 'completed';
  const result = scriptResult(failed ? (partError(call) ?? '') : partOutput(call));
  const cards = failed ? null : scriptCards(result);
  const names = [...new Set(calls.map((c) => c.name))].join(' · ');
  const summary = calls.length ? `${t('calls', { count: calls.length })}${names ? ` · ${names}` : ''}` : '';

  return (
    <BasicTool
      icon={<CodeIcon className="size-4 shrink-0" />}
      trigger={
        <ScriptTrigger
          title={live ? t('runningScript') : failed ? t('scriptFailed') : t('ranScript')}
          live={live}
          summary={summary}
        />
      }
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={locked}
    >
      <div className={cn(indent && 'mt-1.5', indent)}>
        <div className={cn('relative overflow-hidden', frame)}>
          {calls.length > 0 && (
            <div className={cn(paneInset, 'border-border border-b')}>
              <CallList calls={calls} />
            </div>
          )}
          {code && (
            <div className="relative">
              <div data-scrollable className={cn('max-h-64 overflow-auto', frame && 'bg-muted/40')}>
                <pre
                  className={cn(
                    'text-foreground font-mono text-xs leading-relaxed wrap-break-word whitespace-pre-wrap [&_code]:border-none [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-xs [&_code]:leading-relaxed [&_code]:whitespace-pre-wrap [&_pre]:whitespace-pre-wrap [&_span]:border-none [&_span]:outline-none',
                    paneInset,
                    'pr-11',
                  )}
                >
                  <HighlightedCode code={code} language="javascript">
                    {code}
                  </HighlightedCode>
                </pre>
              </div>
              <div className="absolute top-2 right-2">
                <CopyButton code={code} className="text-muted-foreground hover:text-foreground" />
              </div>
            </div>
          )}
          {(result || status === 'completed') && (
            <div className="border-border relative border-t">
              <div data-scrollable className="max-h-80 overflow-auto">
                {cards ? (
                  <ul data-slot="script-card-lines" className={cn('text-foreground flex flex-col gap-2 text-sm', paneInset, 'pr-11')}>
                    {cards.map((card, index) => (
                      <li key={index} className="flex min-w-0 flex-col gap-0.5 wrap-break-word">
                        <span>{card.title}</span>
                        {card.rows.map((row, rowIndex) => (
                          <span key={rowIndex} className="text-muted-foreground text-xs">
                            {row}
                          </span>
                        ))}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div
                    className={cn(
                      'font-mono text-xs leading-relaxed wrap-break-word whitespace-pre-wrap',
                      failed ? 'text-foreground' : 'text-muted-foreground',
                      paneInset,
                      'pr-11',
                    )}
                  >
                    {result || t('noOutput')}
                  </div>
                )}
              </div>
              {result && (
                <div className="absolute top-2 right-2">
                  <CopyButton code={cards ? scriptCardsText(cards) : result} className="text-muted-foreground hover:text-foreground" />
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </BasicTool>
  );
}

ToolRegistry.register('codemode', CodemodeTool);
