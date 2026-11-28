'use client';

import type { Artifact, ArtifactListScope } from '@kortix/sdk';
import { useArtifactFolders, useArtifactMutations, useArtifacts, useProjectConfig } from '@kortix/sdk/react';
import { Button } from '@kortix/ui/button';

import { EmptyState } from '@kortix/ui/empty-state';
import { ErrorState } from '@kortix/ui/error-state';
import { useSlashFocus } from '@kortix/ui/internal/hooks/use-slash-focus';
import { InputGroupSearch, InputGroupSearchClear, InputGroupSearchIcon, InputGroupSearchInput } from '@kortix/ui/input-group';
import Loading from '@kortix/ui/loading';
import { Skeleton } from '@kortix/ui/skeleton';
import { SortMenu, useStoredSort } from '@kortix/ui/sort-menu';
import { Tabs, TabsList, TabsTrigger } from '@kortix/ui/tabs';
import { errorToast, successToast } from '@kortix/ui/toast';
import {
  ALL_SPACES,
  ProjectPageHeader,
  SpaceFilterTabs,
  spaceFilterLabel,
  spaceScope,
  useSpaceFilter,
  useSpacesEnabled,
} from '@kortix/ui/workspace';
import { CaretRightIcon, FolderPlusIcon, MagnifyingGlassIcon, PlusIcon } from '@phosphor-icons/react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useRef, useState } from 'react';

import { useAuth } from '@/features/providers/auth-provider';
import { useTranslations } from '@/i18n/use-translations';

import { ArtifactFolderActions, ArtifactFolderCrumb, ArtifactFolderEditor, ArtifactFolderTile } from './artifact-folders';
import { folderChildren, folderPath } from './artifact-folder-tree';
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
  const tCommon = useTranslations('common');
  const folders = useArtifactFolders(projectId);
  const router = useRouter();
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const folderId = searchParams.get('folder');
  const setFolderId = (id: string | null) => {
    const params = new URLSearchParams(searchParams.toString());
    if (id) params.set('folder', id);
    else params.delete('folder');
    router.push(`${pathname}${params.size ? `?${params}` : ''}`, { scroll: false });
  };
  const [creatingFolder, setCreatingFolder] = useState(false);
  const allFolders = folders.data ?? [];
  const currentFolder = allFolders.find(f => f.folder_id === folderId);
  // The crumbs above the open folder (root first), and the folders inside it.
  const ancestors = folderPath(allFolders, folderId).slice(0, -1);
  const childFolders = folderChildren(allFolders, currentFolder ? currentFolder.folder_id : null);
  const [scope, setScope] = useState<ArtifactListScope>('all');
  const [q, setQ] = useState('');
  // As on Skills: the search is focused on arrival (desktop), and "/" jumps back to it.
  const searchRef = useRef<HTMLInputElement>(null);
  useSlashFocus(searchRef);
  const grid = useColumnWidth();
  const { create } = useArtifactMutations(projectId);
  const newDoc = async () => {
    try {
      const a = await create.mutateAsync({ folder_id: folderId, files: { 'index.md': { content: `# ${t('untitledDoc')}\n\n` } } });
      successToast(t('docCreated'), { actions: [{ label: t('open'), onClick: () => router.push(artifactHref(projectId, a.artifact_id)) }] });
    } catch { errorToast(t('docCreateFailed')); }
  };
  // One list, filtered here: a tab or a search changes what shows, not what is mounted, so no
  // card (or its live preview) remounts. A project at the list's page size may hold more than
  // it shows: there a filter asks the server.
  const viewerId = useAuth().user?.id;
  const query = q.trim().toLowerCase();
  const filtered = scope !== 'all' || !!query;
  const all = useArtifacts(projectId, { scope: 'all', folder_id: folderId ?? (filtered ? undefined : 'root') });
  const paged = (all.data?.length ?? 0) >= LIST_PAGE;
  const server = useArtifacts(paged && filtered ? projectId : null, { scope, q: query || undefined, folder_id: folderId ?? undefined });
  // Keep loaded cards while the first server-filtered page is in flight.
  const useServer = paged && filtered && (server.data !== undefined || server.isError);
  const list = useServer ? server : all;
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
    (useServer ? cards : cards.filter((a) => matches(a, scope, query, viewerId))).filter(
      (artifact) => space === ALL_SPACES || spaceOf(artifact) === space,
    ),
    sort,
  );

  return (
    <div role="region" aria-label={t('title')} className="flex h-svh flex-col overflow-hidden">
      {creatingFolder ? <ArtifactFolderEditor projectId={projectId} parent={currentFolder ?? null} onClose={() => setCreatingFolder(false)} /> : null}
      <ProjectPageHeader
        // In a folder the header is its path: Artifacts › parents › the folder (the h1), then its menu.
        title={
          !folderId
            ? t('title')
            : (currentFolder?.name ?? (folders.isError ? t('folderLoadFailed') : folders.isSuccess ? t('folderUnavailable') : ''))
        }
        breadcrumb={
          folderId ? (
            <nav aria-label={t('folderNavigation')} className="me-0.5 flex min-w-0 shrink items-center gap-2">
              {/* A phone shows only the parent crumb: the open folder's name keeps the room. */}
              <span className={`min-w-0 shrink items-center ${ancestors.length ? 'hidden sm:flex' : 'flex'}`}>
                <ArtifactFolderCrumb projectId={projectId} folderId={null} name={t('title')} onOpen={() => setFolderId(null)} back={!ancestors.length} />
              </span>
              {ancestors.map((folder, index) => (
                <span key={folder.folder_id} className={`min-w-0 shrink items-center gap-2 ${index === ancestors.length - 1 ? 'flex' : 'hidden sm:flex'}`}>
                  <CaretRightIcon className="text-muted-foreground hidden size-3 shrink-0 sm:block" aria-hidden />
                  <ArtifactFolderCrumb projectId={projectId} folderId={folder.folder_id} name={folder.name} onOpen={() => setFolderId(folder.folder_id)} back={index === ancestors.length - 1} />
                </span>
              ))}
              <CaretRightIcon className="text-muted-foreground hidden size-3 shrink-0 sm:block" aria-hidden />
            </nav>
          ) : undefined
        }
        titleAccessory={
          folderId && !currentFolder && !folders.isSuccess && !folders.isError ? (
            <span role="status" aria-label={tCommon('loading')}><Loading className="size-3.5" /></span>
          ) : currentFolder ? (
            <span className="ms-0.5 flex shrink-0">
              <ArtifactFolderActions folder={currentFolder} folders={allFolders} projectId={projectId} />
            </span>
          ) : undefined
        }
      >
        <Button size="sm" variant="outline" className="gap-1.5" aria-label={t('newFolder')} onClick={() => setCreatingFolder(true)} disabled={!!folderId && !currentFolder}><FolderPlusIcon className="size-3.5" /><span className="sr-only sm:not-sr-only">{t('newFolder')}</span></Button>
        <SortMenu
          value={sort}
          onValueChange={setSort}
          options={ARTIFACT_SORTS.map((mode) => ({ value: mode, label: sortLabel[mode] }))}
          label={tSort('sortBy', { mode: sortLabel[sort] })}
        />
        <Button size="sm" className="gap-1.5" onClick={newDoc} disabled={create.isPending || (!!folderId && !currentFolder)} aria-busy={create.isPending}>
          {create.isPending ? <Loading className="size-3.5 shrink-0" /> : <PlusIcon className="size-3.5 shrink-0" />}
          {t('newDoc')}
        </Button>
      </ProjectPageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-4 py-8 pb-20 md:px-8">
          {!folderId && folders.isError ? <ErrorState title={t('folderLoadFailed')} action={<Button variant="outline" size="sm" onClick={() => folders.refetch()}>{t('retry')}</Button>} /> : null}
          {!filtered && childFolders.length ? <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">{childFolders.map(folder => <ArtifactFolderTile key={folder.folder_id} folder={folder} folders={allFolders} projectId={projectId} onOpen={() => setFolderId(folder.folder_id)} />)}</div> : null}
          <section className="flex flex-col gap-4">
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
                <Tabs className="min-w-0 overflow-x-auto" value={scope} onValueChange={(v) => setScope(v as ArtifactListScope)}>
                  <TabsList variant="segmented" className="w-max">
                    {SCOPES.map((s) => (
                      <TabsTrigger key={s} value={s} id={`artifact-scope-${s}`} aria-controls="artifact-gallery-panel" className="px-1.5 sm:px-3">
                        {t(`scope.${s}`)}
                      </TabsTrigger>
                    ))}
                  </TabsList>
                </Tabs>
                {/* The search, focused on arrival on desktop; "/" jumps back to it. */}
                <InputGroupSearch className="w-full min-w-0 sm:w-64">
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
                  <InputGroupSearchClear className="size-7" onClick={() => setQ('')} />
                </InputGroupSearch>
              </div>
              <SpaceFilterTabs spaces={spaces} groups={groups} value={space} onValueChange={setSpace} />
            </div>

            <div id="artifact-gallery-panel" role="tabpanel" aria-labelledby={`artifact-scope-${scope}`} tabIndex={0}>
            {folderId && folders.isError ? (
              <ErrorState title={t('folderLoadFailed')} action={<Button size="sm" variant="outline" onClick={() => folders.refetch()}>{t('retry')}</Button>} />
            ) : folderId && folders.isSuccess && !currentFolder ? (
              <ErrorState title={t('folderUnavailable')} action={<Button size="sm" variant="outline" onClick={() => setFolderId(null)}>{t('title')}</Button>} />
            ) : list.isError ? (
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
            ) : (<>
              {shown.length === 0 && !create.isPending && paged && filtered && (server.isLoading || server.isPlaceholderData) ? (
                <div role="status" aria-label={tCommon('loading')} className="flex justify-center py-12"><Loading className="size-5" /></div>
              ) : shown.length === 0 && !create.isPending ? (
              <EmptyState
                title={
                  q || scope !== 'all'
                    ? t('emptyFiltered')
                    : space !== ALL_SPACES
                      ? t('spaceEmpty', { space: spaceFilterLabel(space, spaces, t('projectWide')) })
                      : folderId ? t('emptyFolder') : childFolders.length ? t('emptyUnfiled') : t('empty')
                }
                description={q || scope !== 'all' || space !== ALL_SPACES || folderId || childFolders.length ? undefined : t('emptyHint')}
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
              ) : null}
              <div ref={grid} className="grid grid-cols-1 gap-x-6 gap-y-10 sm:grid-cols-2 lg:grid-cols-3">
                {/* The new doc while the server writes it: the click shows at once, then the page opens. */}
                {create.isPending ? <CreatingCard /> : null}
                {cards.map((artifact) => (
                  <ArtifactCard
                    key={artifact.artifact_id}
                    projectId={projectId}
                    artifact={artifact}
                    folders={allFolders}
                    hidden={!shown.includes(artifact)}
                    space={spacesOn && space === ALL_SPACES ? labels.get(spaceOf(artifact)) : undefined}
                    current={spaceOf(artifact)}
                    spaces={spaces}
                  />
                ))}
              </div>
            </>)}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
