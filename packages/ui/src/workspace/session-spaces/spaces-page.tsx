'use client';

import type { ProjectSessionGroup } from '@kortix/sdk';
import { useFeatureFlag, useWorkspaceSessionGroups } from '@kortix/sdk/react';
import {
  CaretDownIcon,
  DotsThreeIcon,
  LockSimpleIcon,
  MagnifyingGlassIcon,
  PlusIcon,
  StackIcon,
  UsersIcon,
  UsersThreeIcon,
} from '@phosphor-icons/react';
import { formatDistanceToNowStrict } from 'date-fns';
import { useState, type ReactNode } from 'react';

import { FeatureGateScreen } from '../../customize/shared/feature-gate-screen';
import { useTranslations } from '../../i18n';
import { ProjectPageHeader } from '../../internal/layout/project-page-header';
import { uiRoutes } from '../../lib/routes';
import { cn } from '../../lib/utils';
import { Button } from '../../primitives/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../../primitives/collapsible';
import { EmptyArt } from '../../primitives/empty-art';
import { EmptyState } from '../../primitives/empty-state';
import { ErrorState } from '../../primitives/error-state';
import { ExpandableSearch } from '../../primitives/expandable-search';
import { Skeleton } from '../../primitives/skeleton';
import { SortMenu, useStoredSort } from '../../primitives/sort-menu';
import { UiLink as Link, useUiRouter, useUiViewerId } from '../../providers/ui-provider';
import { SpaceSettingsMenu } from './space-detail-page';
import { SpaceFormModal } from './space-form-modal';
import { SpaceIconBare } from './space-icon';
import { spaceAudience, spaceParticipants } from './space-people';
import { SessionParticipantStack } from '../../session/participants/session-participants';

type SpaceSort = 'activity' | 'name' | 'created';
const SORTS: SpaceSort[] = ['activity', 'name', 'created'];
const SORT_STORAGE_KEY = 'kortix:spaces-sort';
const SKELETON_KEYS = ['a', 'b', 'c', 'd', 'e'];

/**
 * The workspace's Spaces (flag `session_groups`) as one list: a header bar
 * (sort, search, New space), then the spaces the viewer made and the spaces
 * shared with them, each a collapsible group of one-line rows.
 */
export function SpacesPage({ projectId }: { projectId: string }) {
  const t = useTranslations('sessionSpaces');
  const flag = useFeatureFlag(projectId, 'session_groups');
  const groups = useWorkspaceSessionGroups(flag.enabled ? projectId : null);
  const viewerId = useUiViewerId();
  const router = useUiRouter();
  const [search, setSearch] = useState('');
  const [sort, setSort] = useStoredSort<SpaceSort>(SORT_STORAGE_KEY, SORTS, 'activity');
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<ProjectSessionGroup | null>(null);

  if (flag.isLoading) return null;
  if (!flag.enabled) {
    return <FeatureGateScreen featureKey="session_groups" featureName={t('title')} description={t('gateDescription')} />;
  }

  const spaces = groups.data ?? [];
  const query = search.trim().toLowerCase();
  const shown = sortSpaces(
    query
      ? spaces.filter(
          (space) => space.name.toLowerCase().includes(query) || (space.description ?? '').toLowerCase().includes(query),
        )
      : spaces,
    sort,
  );
  // Without a known viewer every space counts as theirs: one group, no empty "Shared" header.
  const mine = shown.filter((space) => !viewerId || space.created_by === viewerId);
  const shared = shown.filter((space) => viewerId && space.created_by !== viewerId);
  const open = (space: ProjectSessionGroup) => {
    const href = uiRoutes().sessionSpace?.(projectId, space.group_id);
    if (href) router.push(href);
  };
  const sortLabel = { activity: t('sortActivity'), name: t('sortName'), created: t('sortCreated') };

  let body: ReactNode;
  if (groups.isLoading) {
    body = (
      <ul aria-hidden className="space-y-1 px-3">
        {SKELETON_KEYS.map((key) => (
          <li key={key} className="flex h-11 items-center gap-3">
            <Skeleton className="size-6 shrink-0 rounded-md py-0" />
            <Skeleton className="h-3.5 w-40 py-0" />
          </li>
        ))}
      </ul>
    );
  } else if (groups.isError) {
    body = (
      <ErrorState
        size="sm"
        title={t('loadFailed')}
        action={
          <Button variant="outline" size="sm" onClick={() => void groups.refetch()}>
            {t('tryAgain')}
          </Button>
        }
      />
    );
  } else if (spaces.length === 0) {
    body = <EmptyState media={<EmptyArt icon={StackIcon} />} title={t('emptyTitle')} description={t('emptyDescription')} />;
  } else if (shown.length === 0) {
    body = (
      <EmptyState media={<EmptyArt icon={MagnifyingGlassIcon} />} title={t('noResultsTitle')} description={t('noResultsDescription')} />
    );
  } else {
    body = (
      <div className="space-y-1">
        {mine.length > 0 ? (
          <SpaceGroup label={t('yourSpaces')} spaces={mine} projectId={projectId} onEdit={setEditing} />
        ) : null}
        {shared.length > 0 ? (
          <SpaceGroup label={t('sharedWithYou')} spaces={shared} projectId={projectId} onEdit={setEditing} />
        ) : null}
      </div>
    );
  }

  return (
    // Capped at the screen height so the header bar stays put and only the list scrolls.
    <div className="bg-background flex h-svh max-h-svh min-h-0 flex-1 flex-col overflow-clip">
      <ProjectPageHeader title={t('title')}>
        {spaces.length > 0 ? (
          <>
            <ExpandableSearch
              value={search}
              onValueChange={setSearch}
              label={t('searchPlaceholder')}
              size="sm"
              buttonVariant="outline"
              className="w-40 sm:w-56"
            />
            <SortMenu
              value={sort}
              onValueChange={setSort}
              options={SORTS.map((mode) => ({ value: mode, label: sortLabel[mode] }))}
              label={t('sortBy', { mode: sortLabel[sort] })}
            />
          </>
        ) : null}
        <Button size="sm" className="gap-1.5" onClick={() => setCreating(true)}>
          <PlusIcon className="size-3.5 shrink-0" />
          <span className="hidden sm:inline">{t('newSpace')}</span>
        </Button>
      </ProjectPageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2 sm:px-3">{body}</div>
      <SpaceFormModal projectId={projectId} space={null} open={creating} onOpenChange={setCreating} onSaved={open} />
      <SpaceFormModal
        projectId={projectId}
        space={editing}
        open={editing !== null}
        onOpenChange={(next) => {
          if (!next) setEditing(null);
        }}
      />
    </div>
  );
}

/** A filled header that folds its rows away, with how many it holds. */
function SpaceGroup({
  label,
  spaces,
  projectId,
  onEdit,
}: {
  label: string;
  spaces: ProjectSessionGroup[];
  projectId: string;
  onEdit: (space: ProjectSessionGroup) => void;
}) {
  return (
    <Collapsible defaultOpen>
      <CollapsibleTrigger className="group/trigger bg-muted/60 text-muted-foreground hover:text-foreground duration-fast flex h-9 w-full items-center gap-2 rounded-md px-3 text-sm transition-colors">
        <span className="truncate">{label}</span>
        <span className="text-muted-foreground tabular-nums">{spaces.length}</span>
        <CaretDownIcon
          aria-hidden
          className="duration-fast ml-auto size-3.5 shrink-0 transition-transform ease-out group-data-[state=closed]/trigger:-rotate-90"
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul className="py-1">
          {spaces.map((space) => (
            <SpaceRow key={space.group_id} projectId={projectId} space={space} onEdit={() => onEdit(space)} />
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * One space on one line: its icon and name, then fixed columns on the right
 * (who is in it, who can open it, when it last moved, its menu) so every row
 * lines up. The menu shows on hover or focus, and always on touch.
 */
function SpaceRow({ projectId, space, onEdit }: { projectId: string; space: ProjectSessionGroup; onEdit: () => void }) {
  const t = useTranslations('sessionSpaces');
  const href = uiRoutes().sessionSpace?.(projectId, space.group_id);
  const audience = spaceAudience(space);
  const when = relativeTime(space.last_activity_at ?? space.updated_at);
  if (!href) return null;
  let access: { icon: ReactNode; label: string };
  if (audience.kind === 'everyone') access = { icon: <UsersThreeIcon className="size-3.5" />, label: t('everyone') };
  else if (audience.kind === 'private') access = { icon: <LockSimpleIcon className="size-3.5" />, label: t('private') };
  else access = { icon: <UsersIcon className="size-3.5" />, label: t('sharedShort') };
  return (
    <li className="group/row hover:bg-hover focus-within:bg-hover duration-fast flex items-center rounded-md pr-2 transition-colors">
      <Link
        href={href}
        prefetch
        className="focus-visible:ring-ring flex h-11 min-w-0 flex-1 items-center gap-3 rounded-md px-3 outline-none focus-visible:ring-2"
      >
        <SpaceIconBare space={space} className="size-5 text-base" />
        <span className="text-foreground min-w-0 flex-1 truncate text-sm first-letter:uppercase">{space.name}</span>
        {audience.kind === 'people' ? (
          <span className="hidden sm:flex">
            <SessionParticipantStack participants={spaceParticipants(space)} label={t('peopleCount', { count: space.people?.length ?? 0 })} />
          </span>
        ) : null}
        <span className="text-muted-foreground hidden w-24 shrink-0 items-center gap-1.5 text-xs sm:flex">
          {access.icon}
          <span className="truncate">{access.label}</span>
        </span>
        <span className="text-muted-foreground w-28 shrink-0 text-right text-xs whitespace-nowrap tabular-nums">{when}</span>
      </Link>
      <span className="ml-1 flex w-7 shrink-0 items-center justify-center">
        {space.can_manage === true ? (
          <SpaceSettingsMenu
            projectId={projectId}
            space={space}
            onEdit={onEdit}
            trigger={
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={t('options')}
                className="text-muted-foreground hover:text-foreground duration-fast opacity-0 transition-opacity group-hover/row:opacity-100 group-focus-within/row:opacity-100 pointer-coarse:opacity-100 data-[state=open]:opacity-100"
              >
                <DotsThreeIcon weight="bold" className="size-4" />
              </Button>
            }
          />
        ) : null}
      </span>
    </li>
  );
}

function sortSpaces(spaces: ProjectSessionGroup[], sort: SpaceSort): ProjectSessionGroup[] {
  const sorted = [...spaces];
  if (sort === 'name') return sorted.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  if (sort === 'created') return sorted.sort((a, b) => b.created_at.localeCompare(a.created_at));
  const moved = (space: ProjectSessionGroup) => space.last_activity_at ?? space.updated_at;
  return sorted.sort((a, b) => moved(b).localeCompare(moved(a)));
}

/** "3h ago" from an ISO time; empty when it does not parse. */
function relativeTime(iso: string): string | null {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  return formatDistanceToNowStrict(at, { addSuffix: true });
}
