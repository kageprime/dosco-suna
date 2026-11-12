'use client';

import { Button } from '@kortix/ui/button';
import { EmptyState } from '@kortix/ui/empty-state';
import { Hint } from '@kortix/ui/hint';
import { UnifiedMarkdown } from '@kortix/ui/markdown';
import { Skeleton } from '@kortix/ui/skeleton';
import { uiRoutes } from '@kortix/ui';
import { ProjectPageHeader } from '@kortix/ui/workspace';
import { useTranslations } from '@/i18n/use-translations';
import { CaretRightIcon, CircleDashedIcon, FolderOpenIcon } from '@phosphor-icons/react';
import Link from 'next/link';
import { useState, type ReactNode } from 'react';

/** The goal page's shared primitives: the frame, the skeleton, the unavailable state, the section title, the description, and the small value rows. */


/** The goal page frame: the header (title, breadcrumb, controls) over a scrolling body. */
function GoalFrame({ projectId, title, controls, children }: { projectId: string; title: string; controls?: ReactNode; children: ReactNode }) {
  const t = useTranslations('goals');
  const listHref = uiRoutes().goals(projectId) ?? '#';
  return (
    <div className="flex h-svh flex-col overflow-hidden">
      <ProjectPageHeader
        title={title}
        breadcrumb={
          <>
            <Link href={listHref} className="text-muted-foreground hover:text-foreground focus-visible:ring-ring shrink-0 rounded-sm text-sm outline-none focus-visible:ring-2">
              {t('title')}
            </Link>
            <CaretRightIcon className="text-muted-foreground size-3 shrink-0" aria-hidden />
          </>
        }
      >
        {controls}
      </ProjectPageHeader>
      <div className="@container/goal min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-6xl px-4 py-10 pb-24 md:px-10">{children}</div>
      </div>
    </div>
  );
}

function GoalSkeleton() {
  return (
    <div className="flex max-w-2xl flex-col gap-3" aria-busy>
      <Skeleton className="h-8 w-2/3 rounded-md" />
      <Skeleton className="h-4 w-1/2 rounded-md" />
      <Skeleton className="h-24 w-full rounded-md" />
    </div>
  );
}

/** No goal to show: it does not exist, or the viewer may not read it. One sentence, and the way back. */
function GoalUnavailable({ projectId, kind }: { projectId: string; kind: 'notFound' | 'noAccess' }) {
  const t = useTranslations('goals');
  const listHref = uiRoutes().goals(projectId);
  return (
    <EmptyState
      title={kind === 'notFound' ? t('notFound') : t('noAccess')}
      description={kind === 'notFound' ? t('notFoundHint') : t('noAccessHint')}
      action={
        listHref ? (
          <Button asChild size="sm" variant="outline">
            <Link href={listHref}>{t('back')}</Link>
          </Button>
        ) : undefined
      }
      data-testid={kind === 'notFound' ? 'goal-not-found' : 'goal-no-access'}
    />
  );
}

type GoalFilesData = { brief: string | null; log: string | null; notes: string | null; verification: string | null };

function SectionTitle({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <h2 className="text-muted-foreground flex items-center gap-2 text-sm font-medium">{children}</h2>
      {aside}
    </div>
  );
}

/** Characters past which the description starts folded: an agent's working notes can run to pages. */
const LONG_CONTEXT = 700;

/** The goal's description from GOAL.md, right under the title, folded to its first lines when it is long. */
function GoalDescription({ markdown }: { markdown: string }) {
  const t = useTranslations('goals');
  const long = markdown.length > LONG_CONTEXT;
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="flex flex-col gap-2" data-testid="goal-context">
      <div className={long && !expanded ? 'max-w-prose max-h-56 overflow-hidden [mask-image:linear-gradient(to_bottom,black_60%,transparent)]' : 'max-w-prose'}>
        <UnifiedMarkdown content={markdown} trust="untrusted" variant="document" className="text-base" />
      </div>
      {long ? (
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground w-fit text-sm"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
          data-testid="goal-context-toggle"
        >
          {expanded ? t('showLess') : t('showMore')}
        </button>
      ) : null}
    </div>
  );
}

/** No agent assigned: an empty circle in the agent slot. */
function RobotlessIcon() {
  return <CircleDashedIcon className="size-4" aria-hidden />;
}

/**
 * A GOAL.md value as text, or null. The front matter is hand-editable and the parser keeps
 * values as written: a number, list or map must never reach a React child or a string helper.
 */
function text(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

/** A folder action: the shared ghost icon button, labelled with what it opens. */
function OpenFolderAction({ href, file }: { href: string; file: string }) {
  const t = useTranslations('goals');
  return (
    <Hint label={t('openInFiles')}>
      <Button asChild variant="ghost" size="icon-xs" className="text-muted-foreground hover:text-foreground shrink-0">
        <Link href={href} aria-label={t('openFolderOf', { file })}>
          <FolderOpenIcon className="size-3.5" aria-hidden />
        </Link>
      </Button>
    </Hint>
  );
}

/** An evidence file: its name, and a way to its folder in Files that says it opens the folder. */
function EvidenceFile({ path, folder, driveHref }: { path: string; folder: string; driveHref: string | null }) {
  const parent = `${folder}/${path}`.split('/').slice(0, -1).join('/');
  return (
    <span className="text-muted-foreground flex min-w-0 items-center gap-1.5 text-xs">
      <span className="min-w-0 truncate">{path}</span>
      {driveHref ? <OpenFolderAction href={`${driveHref}?path=${encodeURIComponent(parent)}`} file={path} /> : null}
    </span>
  );
}

export { EvidenceFile, GoalDescription, GoalFrame, GoalSkeleton, GoalUnavailable, RobotlessIcon, SectionTitle, text };
export type { GoalFilesData };
