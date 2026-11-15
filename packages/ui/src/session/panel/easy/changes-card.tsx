'use client';

/**
 * `ChangesCard` — the files this session changed against its base, one row per
 * file. A row opens THAT file's diff in the detail panel; the last row
 * ("Review changes") opens the full comparison. Same row rhythm as Outputs, so the two sections read as
 * one list.
 *
 * Renders nothing until the answer is known and non-empty: a booting runtime,
 * a project without git, or a session with no edits adds no section, which
 * keeps an empty or chat-only session to the sections it actually has.
 */

import { ArrowRightIcon, FileTextIcon } from '@phosphor-icons/react';
import { useTranslations } from '../../../i18n';
import { SessionDiffViewer } from '../session-diff-viewer';
import { CHANGE_STATUS_META, useSessionChanges } from '../session-changes-shared';
import { CountBadge } from '../../../primitives/count-badge';
import { STATUS_DOT } from '../../../primitives/status';
import { useLocalizedUiCatalog } from '../../../i18n/ui-catalog/use-localized-ui-catalog';
import { cn } from '../../../lib/utils';
import type { VcsFileDiff } from '@kortix/sdk/react';
import type { Detail } from './detail-view';
import { ChalkTile, chalkLabel } from './outputs-card';
import { PanelCard } from './panel-card';
import { getFileIcon } from '../../../files/project/components/file-icon';

/** Rows shown before the fold; the fold opens the full comparison. */
const VISIBLE_ROWS = 5;

function splitPath(file: string): { name: string; dir: string } {
  const cut = file.lastIndexOf('/');
  return cut < 0 ? { name: file, dir: '' } : { name: file.slice(cut + 1), dir: file.slice(0, cut) };
}

type ChangesCardProps = {
  /** Opens one file's diff in the detail panel. */
  onOpenDetail: (detail: Detail) => void;
  /** Opens the full comparison (Files → Changes). */
  onOpenAll: () => void;
};

export function ChangesCard(props: ChangesCardProps) {
  const { files, isPending, isTracked } = useSessionChanges();
  if (isPending || !isTracked || files.length === 0) return null;
  return <ChangesSection files={files} {...props} />;
}

/** The section itself, from a known non-empty file list. Pure: tests render it directly. */
export function ChangesSection({
  files,
  onOpenDetail,
  onOpenAll,
}: ChangesCardProps & { files: VcsFileDiff[] }) {
  const t = useTranslations('hardcodedUi.i18nComplete');
  const statusMeta = useLocalizedUiCatalog(CHANGE_STATUS_META);
  const count = files.length;
  const visible = files.slice(0, VISIBLE_ROWS);
  const hidden = count - visible.length;

  const openFile = (file: string) => {
    const { name } = splitPath(file);
    onOpenDetail({
      key: `diff:${file}`,
      title: name,
      icon: <FileTextIcon className="text-foreground size-4 shrink-0" />,
      padded: false,
      body: <SessionDiffViewer filePath={file} />,
    });
  };

  return (
    <PanelCard title={t.raw('textbbd4b6a86bc6')} count={count} isEmpty={false} defaultExpanded contentClassName="pb-2">
      <ul>
        {visible.map((f) => {
          const { name, dir } = splitPath(f.file);
          // Added / Edited / Removed, as the full comparison shows it: a line
          // count alone cannot tell a deleted file from an edit that removed lines.
          const status = f.status ? statusMeta[f.status] : undefined;
          return (
            <li key={f.file}>
              <button
                type="button"
                title={status ? `${status.label}: ${f.file}` : f.file}
                onClick={() => openFile(f.file)}
                className="hover:bg-accent flex w-full items-center gap-2.5 px-4 py-1.5 text-left transition-[background-color,transform] active:scale-[0.998]"
              >
                <ChalkTile label={chalkLabel({ kind: 'file', name })}>
                  {getFileIcon(name, { className: 'size-3.5', variant: 'monochrome' })}
                </ChalkTile>
                {status && (
                  <span
                    data-status={f.status}
                    className={cn('size-1.5 shrink-0 rounded-full', STATUS_DOT[status.tone])}
                    aria-label={status.label}
                    role="img"
                  />
                )}
                <span className="min-w-0 flex-1 truncate text-sm">
                  <span className="text-foreground">{name}</span>
                  {dir && <span className="text-muted-foreground ml-1.5 text-xs">{dir}</span>}
                </span>
                {/* Only the sides that moved: a new file reads "+12", a deleted
                    one "−8", and a binary change (no line counts) shows none. */}
                {(f.additions > 0 || f.deletions > 0) && (
                  <span className="flex shrink-0 gap-1.5 text-xs tabular-nums">
                    {f.additions > 0 && <span className="text-kortix-green">+{f.additions}</span>}
                    {f.deletions > 0 && <span className="text-kortix-red">−{f.deletions}</span>}
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
      {hidden > 0 && (
        <button
          type="button"
          onClick={onOpenAll}
          className="text-muted-foreground hover:text-foreground hover:bg-accent mt-0.5 flex w-full items-center gap-2.5 px-4 py-1.5 text-left text-sm transition-[background-color,color,transform] active:scale-[0.998]"
        >
          {/* Navigates to the full comparison: an arrow, never the Outputs
              fold's caret, which expands in place. */}
          <span className="flex size-6 shrink-0 items-center justify-center">
            <ArrowRightIcon className="size-3.5" />
          </span>
          <span className="flex-1 truncate">{t.raw('text6a47708f4e14')}</span>
          {/* A count of files, not of lines: the CountBadge, never the
              green/red delta style of the rows above. */}
          <CountBadge count={hidden} />
        </button>
      )}
    </PanelCard>
  );
}
