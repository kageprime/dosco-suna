'use client';

import { useTranslations } from '../../../i18n';
/**
 * `ContextCard` — "what the agent LOOKED AT," as rows.
 *
 * It used to be three labelled lists ("Web sources", "Files read", "Tools
 * used") stacked inside the card, which turned a summary into a wall of rows;
 * then one flat wrap of pills, which gave every group a different width and
 * left the counts scattered across the card with nothing to line them up.
 * Now each group is one full-width row — icon, name, count, chevron — the same
 * row language the Outputs card uses, so the two cards sharing one panel read
 * as one system. Tapping a row slides open the `DetailLayer` — the same
 * surface a Progress step opens, so there is exactly one rule to learn.
 *
 * In the detail, web sources get the treatment they deserve — the site's own
 * favicon, the page title, and the real URL — instead of being flattened into
 * a bare line of text.
 *
 * **Empty-state actions (Task 5).** An empty card used to be a dead promise —
 * a sentence with nothing to act on. "Add context" hands the user straight
 * to the composer's attach flow (`onAddContext`, a plain callback — see
 * `easy-panel.tsx` for what it's wired to).
 *
 * **Connect apps removed.** This card used to also carry a "Connect apps"
 * affordance — an empty-state button, a non-empty footer row, both revealing
 * `ConnectAppsStrip` in place, gated on a `projectId` prop. Product decision:
 * gone. Removed with it: `ConnectAppsStrip`/`connect-apps-strip.tsx`, the
 * `connectAppsOpen`/`onToggleConnectApps` state that used to be hoisted to
 * `EasyPanel`, and the `projectId` prop this card no longer needs. This was
 * the whole surface — nothing else in the panel referenced it.
 */

import { Button } from '../../../primitives/button';
import { FaviconAvatar } from '../../../primitives/favicon-avatar';
import { getFileIcon } from '../../../files/project/components/file-icon';
import { ContextMeter } from './context-meter';
import type { ContextUsage } from '../../composer/context-usage';
import { cn } from '../../../lib/utils';
import {
  CaretRightIcon,
  ChatsTeardropIcon,
  FileTextIcon as FileText,
  GlobeIcon as Globe,
  PlusIcon as Plus,
} from '@phosphor-icons/react';
import type { ContextItem } from '../shared/derive-panels';
import type { StepFamily } from '@kortix/sdk';
import { familyForTool, narrateFailedStep, narrateStep } from '@kortix/sdk';
import type { Detail } from './detail-view';
import { safeHttpUrl } from '@kortix/shared';
import { ToolParts } from './detail-view';
import { multiAgentTool } from '../../tool/tools/kortix-tool-card';
import { PANEL_ROW, PANEL_ROW_ICON, PanelCard } from './panel-card';
import { STATUS_DOT } from '../../../primitives/status';
import { StepIcon } from './step-icon';

/** One row = one group of things the agent consulted. */
interface ContextGroup {
  id: string;
  label: string;
  count: number;
  icon: React.ReactNode;
  /** What the detail view shows when this row is opened. */
  body: React.ReactNode;
  /** One of its calls failed: the row carries a red dot. */
  failed?: boolean;
}

export function ContextCard({
  files,
  web,
  tools,
  sessionId,
  onOpenDetail,
  onOpenFile,
  onAddContext,
  usage,
}: {
  /** How full the model's context window is (`useSessionContextUsage`). Drawn
   *  as the meter on top; null before the first reply. */
  usage?: ContextUsage | null;
  files: ContextItem[];
  web: ContextItem[];
  tools: ContextItem[];
  sessionId: string;
  /** Detail replaces the whole panel — so the panel, not this card, owns it. */
  onOpenDetail: (detail: Detail) => void;
  /** Opens a "Files read" row in the file viewer, with the ordered path list
   *  of every OTHER openable row in the group so the viewer can wire prev/next
   *  nav across the read set — see `FileList`. */
  onOpenFile: (path: string, allPaths: string[]) => void;
  /** Empty-state "Add context" button. A plain callback, same pattern as
   *  `onOpenFile` — this card grows no store dependency of its own; see
   *  `easy-panel.tsx` for what it's wired to. */
  onAddContext: () => void;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const groups: ContextGroup[] = [];

  if (web.length) {
    groups.push({
      id: 'web',
      label: tI18nComplete.raw('text033c214ae9a3'),
      count: web.length,
      icon: <Globe className="text-foreground size-4 shrink-0" />,
      body: <WebSourceList items={web} />,
    });
  }

  if (files.length) {
    groups.push({
      id: 'files',
      label: tI18nComplete.raw('text83480f565627'),
      count: files.length,
      icon: <FileText className="text-foreground size-4 shrink-0" />,
      body: <FileList items={files} onOpenFile={onOpenFile} />,
    });
  }

  // Every other tool the agent reached for keeps its own row, with the same
  // family glyph it wears in the Progress stepper — one tool, one icon, both
  // places. A tool row's detail shows what it actually did.
  for (const tool of tools) {
    const family: StepFamily =
      (familyForTool(tool.calls?.[0]?.name ?? '') as StepFamily) ?? 'other';
    // `deriveContext` skips *fully* errored calls, but this row aggregates ALL
    // calls to that tool — one failed call among several is exactly what a
    // status="done" glyph would hide (failed-call aggregation).
    const failed = (tool.calls ?? []).some((c) => c.status === 'error');
    // The row's detail opens straight onto raw tool views (W3) — a plain
    // sentence above them, in the same voice the Progress stepper narrates
    // with, is what tells a non-technical reader what they're looking at
    // before they have to parse a diff or a JSON blob. Reuses `narrateStep`/
    // `narrateFailedStep` — the same pair `group-steps.ts`'s `finalize` calls
    // for the Progress card's own step label — rather than a second sentence
    // table (the rule `narration.ts:12-14` and `derive-panels.ts:1-14` both
    // enforce).
    const summary = failed
      ? narrateFailedStep(family, tool.calls ?? [])
      : narrateStep(family, tool.calls ?? []);
    groups.push({
      id: tool.callID,
      label: tool.label,
      count: tool.calls?.length ?? 1,
      failed,
      // A message to another agent is a conversation, not a settings change: its own glyph.
      icon:
        multiAgentTool(tool.calls?.[0]?.name ?? '') === 'send_message' ? (
          <ChatsTeardropIcon className={cn('size-4 shrink-0', failed ? 'text-kortix-red' : 'text-foreground')} />
        ) : (
          <StepIcon family={family} status={failed ? 'error' : 'done'} tone="foreground" />
        ),
      body: <ToolParts calls={tool.calls ?? []} sessionId={sessionId} summary={summary} />,
    });
  }

  return (
    <PanelCard
      title={tI18nComplete.raw('texta6e600a10fed')}
      isEmpty={groups.length === 0 && !usage}
      emptyText={tI18nComplete.raw('textc63adab9bd56')}
      emptyActions={
        <Button variant="outline" size="sm" className="gap-1.5" onClick={onAddContext}>
          <Plus className="size-3.5" />
          {tI18nComplete.raw('text0f01d14cacf0')}
        </Button>
      }
    >
      {usage && <ContextMeter usage={usage} />}
      {/* What the agent brought into the conversation, under the meter: one
          row per source, each opening what it did. The caret leads, the count
          trails, on the same label edge as the meter's legend. */}
      <ul className={cn('flex flex-col', usage && groups.length > 0 && 'mt-2')}>
        {groups.map((g) => (
          <li key={g.id} className="flex">
            <button
              type="button"
              onClick={() => onOpenDetail({ key: g.id, title: g.label, icon: g.icon, body: g.body })}
              className={cn(PANEL_ROW, 'text-muted-foreground hover:text-foreground cursor-pointer')}
            >
              <span className={PANEL_ROW_ICON}>
                <CaretRightIcon className="size-3.5!" />
              </span>
              <span className="min-w-0 flex-1 truncate">{g.label}</span>
              {g.failed && (
                <span className={cn('size-1.5 shrink-0 rounded-full', STATUS_DOT.destructive)} aria-hidden />
              )}
              <span className="tabular-nums">{g.count}</span>
            </button>
          </li>
        ))}
      </ul>
    </PanelCard>
  );
}

const ROW = cn(
  'flex min-h-12 w-full items-center gap-3 rounded-md px-2.5 py-2 text-left',
  'bg-muted/40 transition-colors',
);

/**
 * Favicon, then the page title, then its URL pushed to the far edge — the
 * title is what you're looking for and the URL is what confirms it, so they
 * sit at opposite ends of the row rather than stacked on top of each other.
 * The title takes the slack; the URL keeps its own width and never squeezes
 * the title out.
 */
function WebSourceList({ items }: { items: ContextItem[] }) {
  return (
    <ul className="flex min-w-0 flex-col gap-1.5">
      {items.map((it) => (
        <li key={`${it.callID}:${it.url ?? it.label}`}>
          <a
            href={safeHttpUrl(it.url) ?? undefined}
            target="_blank"
            rel="noreferrer noopener"
            className={cn(ROW, 'hover:bg-muted cursor-pointer justify-between gap-4')}
          >
            <span className="flex min-w-0 flex-1 items-center gap-3">
              <FaviconAvatar value={it.url ?? it.label} size="sm" alt="" className="shrink-0" />
              <span className="text-foreground truncate text-sm">{it.label}</span>
            </span>
            {it.url && (
              <span className="text-muted-foreground max-w-[45%] shrink-0 truncate text-xs">
                {prettyUrl(it.url)}
              </span>
            )}
          </a>
        </li>
      ))}
    </ul>
  );
}

/**
 * Every item carries its own per-extension glyph, the same tile the files
 * explorer and the Outputs card use — a `.md` reads as a `.md` here too, not
 * as an anonymous document. An item with a `path` opens in the file viewer:
 * clicking it calls `onOpenFile` with its own path plus the ordered path list
 * of every OTHER openable item in the group, so the viewer can wire prev/next
 * nav across the whole read set. An item without a `path` (`deriveContext`
 * only sets one when a `read` call actually resolved to a real file) stays a
 * plain row — nothing to open, so no button semantics to fake.
 */
function FileList({
  items,
  onOpenFile,
}: {
  items: ContextItem[];
  onOpenFile: (path: string, allPaths: string[]) => void;
}) {
  const allPaths = items.flatMap((it) => (it.path ? [it.path] : []));

  return (
    <ul className="flex min-w-0 flex-col gap-1.5">
      {items.map((it) =>
        it.path ? (
          <li key={it.callID}>
            <button
              type="button"
              onClick={() => onOpenFile(it.path as string, allPaths)}
              className={cn(
                ROW,
                'hover:bg-muted cursor-pointer transition-[background-color,transform] active:scale-[0.998]',
              )}
            >
              {/* `rounded-sm` (6px) inside the row's `rounded-md` (8px): a
                  tile is a status tile, and a tile that matched its own row's
                  radius read as a second card rather than a mark inside one.
                  Same tile the Outputs card's `OutputIcon` draws. */}
              <span className="bg-muted/70 flex size-7 shrink-0 items-center justify-center rounded-sm">
                {getFileIcon(basename(it.label), { className: 'size-4', variant: 'monochrome' })}
              </span>
              <span className="text-foreground truncate text-sm">{it.label}</span>
            </button>
          </li>
        ) : (
          <li key={it.callID} className={ROW}>
            <span className="bg-muted/70 flex size-7 shrink-0 items-center justify-center rounded-sm">
              <FileText className="text-muted-foreground size-3.5" />
            </span>
            <span className="text-foreground truncate text-sm">{it.label}</span>
          </li>
        ),
      )}
    </ul>
  );
}

/** Last path segment — `getFileIcon` keys off the extension, and `it.label`
 *  can occasionally BE a full path (`deriveContext`'s `label: ... || path`
 *  fallback), which would otherwise feed it directory segments instead of a
 *  filename. */
function basename(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path;
}

/** The URL, minus the ceremony a non-technical reader doesn't need. */
function prettyUrl(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

