'use client';

import type { Artifact, ArtifactListScope } from '@kortix/sdk';
import { useArtifactMutations, useArtifacts, useProjectConfig } from '@kortix/sdk/react';
import { Button } from '@kortix/ui/button';

import { EmptyState } from '@kortix/ui/empty-state';
import { ErrorState } from '@kortix/ui/error-state';
import { useSlashFocus } from '@kortix/ui/internal/hooks/use-slash-focus';
import { InputGroupSearch, InputGroupSearchClear, InputGroupSearchIcon, InputGroupSearchInput } from '@kortix/ui/input-group';
import Loading from '@kortix/ui/loading';
import { Skeleton } from '@kortix/ui/skeleton';
import { SortMenu, useStoredSort } from '@kortix/ui/sort-menu';
import { Tabs, TabsList, TabsTrigger } from '@kortix/ui/tabs';
import { successToast } from '@kortix/ui/toast';
import {
  ALL_SPACES,
  ProjectPageHeader,
  SpaceFilterTabs,
  spaceFilterLabel,
  spaceScope,
  useSpaceFilter,
  useSpacesEnabled,
} from '@kortix/ui/workspace';
import { MagnifyingGlassIcon, PlusIcon } from '@phosphor-icons/react';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';

import { useAuth } from '@/features/providers/auth-provider';
import { useTranslations } from '@/i18n/use-translations';

import { ArtifactCard, CreatingCard, useColumnWidth } from './artifact-card';
import { artifactHref } from './artifact-meta';

const SCOPES: ArtifactListScope[] = ['all', 'mine', 'shared', 'pinned'];

/** The list route's default page: a project with this many may hold more than the list shows. */
const LIST_PAGE = 100;

/** The list route's own filters (`listArtifacts` in the API), applied in the browser. */
function matches(a: Artifact, scope: ArtifactListScope, q: string, viewerId: string | undefined): boolean {
  if (scope === 'mine' && a.created_by.user_id !== viewerId) return false;
  if (scope === 'shared' && a.created_by.user_id === viewerId) return false;
  if (scope === 'pinned' && !a.pinned) return false;
  return !q || a.title.toLowerCase().includes(q) || !!a.description?.toLowerCase().includes(q);
}

type ArtifactSort = 'activity' | 'name' | 'created';
const ARTIFACT_SORTS: ArtifactSort[] = ['activity', 'name', 'created'];

/** Artifacts in the picked order: last edit, title, or newest first. */
function sortArtifacts(artifacts: Artifact[], sort: ArtifactSort): Artifact[] {
  const sorted = [...artifacts];
  if (sort === 'name') return sorted.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
  const at = (artifact: Artifact) => (sort === 'created' ? artifact.created_at : artifact.updated_at);
  return sorted.sort((a, b) => at(b).localeCompare(at(a)));
}

/**
 * /workspaces/[id]/artifacts — every artifact the viewer may see, as live
 * previews. The header holds the order and New doc; the search sits beside the tabs.
 * A new doc joins the grid where you are; its toast opens it.
 */
export function ArtifactsGallery({ projectId }: { projectId: string }) {
  const t = useTranslations('artifacts');
  const [scope, setScope] = useState<ArtifactListScope>('all');
  const [q, setQ] = useState('');
  // As on Skills: the search is focused on arrival (desktop), and "/" jumps back to it.
  const searchRef = useRef<HTMLInputElement>(null);
  useSlashFocus(searchRef);
  const grid = useColumnWidth();
  const router = useRouter();
  const { create } = useArtifactMutations(projectId);
  const newDoc = async () => {
    const a = await create.mutateAsync({ files: { 'index.md': { content: `# ${t('untitledDoc')}\n\n` } } });
    successToast(t('docCreated'), { actions: [{ label: t('open'), onClick: () => router.push(artifactHref(projectId, a.artifact_id)) }] });
  };
  // One list, filtered here: a tab or a search changes what shows, not what is mounted, so no
  // card (or its live preview) remounts. A project at the list's page size may hold more than
  // it shows: there a filter asks the server.
  const viewerId = useAuth().user?.id;
  const query = q.trim().toLowerCase();
  const filtered = scope !== 'all' || !!query;
  const all = useArtifacts(projectId, { scope: 'all' });
  const paged = (all.data?.length ?? 0) >= LIST_PAGE;
  const server = useArtifacts(paged && filtered ? projectId : null, { scope, q: query || undefined });
  const list = paged && filtered ? server : all;
  const cards = list.data ?? [];
  // An artifact sits in its bound space, else its agent's space, else Project-wide.
  // Spaces are Work in progress: with `chat` off every artifact is
  // project-wide, and the page shows no filter, chip or "Move to space".
  const config = useProjectConfig(projectId);
  const spacesOn = useSpacesEnabled(projectId);
  const { spaces, groups, spaceOf } = spaceScope(cards, config, spacesOn, (artifact) => artifact);
  const labels = new Map(groups.map((group) => [group.name, group.label]));
  const [space, setSpace] = useSpaceFilter(projectId);
  const tSort = useTranslations('listSort');
  const [sort, setSort] = useStoredSort<ArtifactSort>('kortix:artifacts-sort', ARTIFACT_SORTS, 'activity');
  const sortLabel: Record<ArtifactSort, string> = {
    activity: tSort('lastActivity'),
    name: tSort('name'),
    created: tSort('created'),
  };
  const shown = sortArtifacts(
    (paged ? cards : cards.filter((a) => matches(a, scope, query, viewerId))).filter(
      (artifact) => space === ALL_SPACES || spaceOf(artifact) === space,
    ),
    sort,
  );

  return (
    <div className="flex h-svh flex-col overflow-hidden">
      <ProjectPageHeader title={t('title')}>
        <SortMenu
          value={sort}
          onValueChange={setSort}
          options={ARTIFACT_SORTS.map((mode) => ({ value: mode, label: sortLabel[mode] }))}
          label={tSort('sortBy', { mode: sortLabel[sort] })}
        />
        <Button size="sm" className="gap-1.5" onClick={newDoc} disabled={create.isPending} aria-busy={create.isPending}>
          {create.isPending ? <Loading className="size-3.5 shrink-0" /> : <PlusIcon className="size-3.5 shrink-0" />}
          {t('newDoc')}
        </Button>
      </ProjectPageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-4 py-8 pb-20 md:px-8">
          <section className="flex flex-col gap-4">
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <Tabs value={scope} onValueChange={(v) => setScope(v as ArtifactListScope)}>
                  <TabsList variant="segmented">
                    {SCOPES.map((s) => (
                      <TabsTrigger key={s} value={s}>
                        {t(`scope.${s}`)}
                      </TabsTrigger>
                    ))}
                  </TabsList>
                </Tabs>
                {/* The search, focused on arrival on desktop; "/" jumps back to it. */}
                <InputGroupSearch className="min-w-0 flex-1 sm:w-64 sm:flex-none">
                  <InputGroupSearchIcon>
                    <MagnifyingGlassIcon />
                  </InputGroupSearchIcon>
                  <InputGroupSearchInput
                    ref={searchRef}
                    placeholder={t('search')}
                    aria-label={t('search')}
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    variant="popover"
                    size="sm"
                  />
                  <InputGroupSearchClear onClick={() => setQ('')} />
                </InputGroupSearch>
              </div>
              <SpaceFilterTabs spaces={spaces} groups={groups} value={space} onValueChange={setSpace} />
            </div>

            {list.isError ? (
              <ErrorState
                title={t('loadError')}
                action={
                  <Button size="sm" variant="outline" onClick={() => list.refetch()}>
                    {t('retry')}
                  </Button>
                }
              />
            ) : list.isLoading ? (
              <div className="grid grid-cols-1 gap-x-6 gap-y-10 sm:grid-cols-2 lg:grid-cols-3">
                {[0, 1, 2].map((i) => (
                  <Skeleton key={i} className="aspect-[16/10] w-full rounded-lg" />
                ))}
              </div>
            ) : shown.length === 0 && !create.isPending ? (
              <EmptyState
                title={
                  q || scope !== 'all'
                    ? t('emptyFiltered')
                    : space !== ALL_SPACES
                      ? t('spaceEmpty', { space: spaceFilterLabel(space, spaces, t('projectWide')) })
                      : t('empty')
                }
                description={q || scope !== 'all' || space !== ALL_SPACES ? undefined : t('emptyHint')}
                action={
                  // Each empty view offers its way out: clear the filters, show every space, or
                  // start the first doc.
                  q || scope !== 'all' ? (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setQ('');
                        setScope('all');
                      }}
                    >
                      {t('clearFilters')}
                    </Button>
                  ) : space !== ALL_SPACES ? (
                    <Button size="sm" variant="outline" onClick={() => setSpace(ALL_SPACES)}>
                      {t('showAll')}
                    </Button>
                  ) : (
                    <Button size="sm" variant="outline" className="gap-1.5" onClick={newDoc}>
                      <PlusIcon className="size-4" />
                      {t('newDoc')}
                    </Button>
                  )
                }
              />
            ) : (
              <div ref={grid} className="grid grid-cols-1 gap-x-6 gap-y-10 sm:grid-cols-2 lg:grid-cols-3">
                {/* The new doc while the server writes it: the click shows at once, then the page opens. */}
                {create.isPending ? <CreatingCard /> : null}
                {cards.map((artifact) => (
                  <ArtifactCard
                    key={artifact.artifact_id}
                    projectId={projectId}
                    artifact={artifact}
                    hidden={!shown.includes(artifact)}
                    space={spacesOn && space === ALL_SPACES ? labels.get(spaceOf(artifact)) : undefined}
                    current={spaceOf(artifact)}
                    spaces={spaces}
                  />
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
