'use client';

import { Button } from '../../../primitives/button';
import { errorToast, successToast } from '../../../primitives/toast';
import { useFilesStore } from '../../../internal/stores/files-store';
import type { FileNode } from '../../../internal/files/types';
import { EmptyState } from '../../../primitives/empty-state';
import { ErrorState } from '../../../primitives/error-state';
import { FolderOpenIcon as FolderOpen } from '@phosphor-icons/react';
import { useTranslations } from '../../../i18n';
import { useUiPathname, useUiSearchParams, useUiShallowNavigate } from '../../../providers/ui-provider';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { downloadFile } from '../api/runtime-files';
import { useProjectContext } from '../context';
import { useFileExplorerSource } from '../explorer-source';
import { buildGitStatusMap, useFileEventInvalidation, useFileList, useGitStatus } from '../hooks';
import { useOpenChangeRequestList } from '../hooks/use-change-requests';
import { useDirectoryDownload } from '../hooks/use-directory-download';
import { ChangeRequestDetailDialog } from './change-request-detail-dialog';
import { ChangeRequestsPanel } from './change-requests-panel';
import { CheckpointsPanel } from './checkpoints-panel';
import { DriveGridView } from './drive-grid-view';
import { DriveHeader } from './drive-header';
import { DriveListView } from './drive-list-view';
import { FileHistoryPopoverContent } from './file-history-popover';
import { ExplorerFilePreview } from './file-preview-modal';
import { FileSearch } from './file-search';
import { isPartialListing, LoadMoreRow } from './load-more-row';
import { ListingSkeleton, useSortedListing } from './explorer-listing';
import { type FilesRightPanel, requestedFilesRightPanel } from './file-route-state';

/**
 * The project-level file explorer. It has no session context — sharing is
 * scoped to a session's sandbox — so it renders no share control, matching
 * `AppFilePreviewHost`. It previously declared a `shareContext` prop that it
 * never destructured and never forwarded, so any caller passing one got silence
 * instead of a share button; the honest signature is no prop at all. The
 * in-session explorer threads share context through `DriveExplorer` instead.
 */
export function FileExplorerPage({ embedded = false }: { embedded?: boolean } = {}) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const currentPath = useFilesStore((s) => s.currentPath);
  const navigateToPath = useFilesStore((s) => s.navigateToPath);
  const viewMode = useFilesStore((s) => s.viewMode);
  const openFileWithList = useFilesStore((s) => s.openFileWithList);

  // Filename search over the whole repository (KRTX-1723): ⌘P or the `⋯` menu.
  const searchEnabled = useFileExplorerSource().capabilities.search;
  const isSearchOpen = useFilesStore((s) => s.isSearchOpen);
  const toggleSearch = useFilesStore((s) => s.toggleSearch);

  const projectCtx = useProjectContext();
  const projectId = projectCtx?.projectId ?? '';
  const projectRef = projectCtx?.ref ?? '';

  useFileEventInvalidation();

  const listing = useFileList(currentPath);
  const { data: files, isLoading, error, refetch: refetchFiles } = listing;
  const partial = isPartialListing(listing);

  const { data: gitStatuses } = useGitStatus();
  const gitStatusMap = useMemo(() => buildGitStatusMap(gitStatuses), [gitStatuses]);

  const { downloadDir, isDownloading: isDirDownloading } = useDirectoryDownload();

  // Seeded from isLoading, not false: the route's loading.tsx has already
  // painted a skeleton by the time this mounts, so starting at false renders an
  // empty body for 200ms right where the user is looking. Seeding also avoids a
  // one-frame skeleton flash when the listing is already cached (isLoading
  // false on mount). The 200ms anti-flicker delay is for REFETCHES only.
  const hasLoadedOnce = useRef(false);
  const [showSkeleton, setShowSkeleton] = useState(isLoading);
  useEffect(() => {
    if (!isLoading) {
      hasLoadedOnce.current = true;
      setShowSkeleton(false);
      return;
    }
    if (!hasLoadedOnce.current) {
      setShowSkeleton(true);
      return;
    }
    const timer = setTimeout(() => setShowSkeleton(true), 200);
    return () => clearTimeout(timer);
  }, [isLoading]);

  const isRootPath = currentPath === '/' || currentPath === '.' || currentPath === '';

  const { elevatedDirs, dirs, fileItems } = useSortedListing(files, partial);

  const handleNavigateToDir = useCallback(
    (node: FileNode) => {
      navigateToPath(node.path);
    },
    [navigateToPath],
  );

  const handleOpenFile = useCallback(
    (node: FileNode) => {
      const allFiles = fileItems.map((f) => f.path);
      const index = allFiles.indexOf(node.path);
      openFileWithList(node.path, allFiles, Math.max(0, index));
    },
    [fileItems, openFileWithList],
  );

  const handlePreviewFile = handleOpenFile;

  const handleDownload = useCallback(
    async (node: FileNode) => {
      if (!projectId || !projectRef) return;
      try {
        await downloadFile(projectId, projectRef, node.path, node.name);
        successToast(tHardcodedUi('i18nComplete.text7eca5e05f915', { value0: node.name }));
      } catch {
        errorToast(tHardcodedUi('i18nComplete.textc85c359673e0', { value0: node.name }));
      }
    },
    [projectId, projectRef, tHardcodedUi],
  );

  const handleDownloadDir = useCallback(
    (node: FileNode) => {
      downloadDir(node.path, node.name);
    },
    [downloadDir],
  );

  const handleHistory = useCallback((node: FileNode) => {
    setHistoryPopoverPath(node.path);
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
        return;
      if ((e.metaKey || e.ctrlKey) && e.key === 'p' && searchEnabled) {
        e.preventDefault();
        toggleSearch();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [searchEnabled, toggleSearch]);

  const [historyPopoverPath, setHistoryPopoverPath] = useState<string | null>(null);

  const [rightPanel, setRightPanel] = useState<FilesRightPanel>(null);
  const [createdCrId, setCreatedCrId] = useState<string | null>(null);
  const toggleRightPanel = (panel: FilesRightPanel) =>
    setRightPanel((current) => (current === panel ? null : panel));

  const openCrCountQuery = useOpenChangeRequestList({ refetchInterval: 10_000 });
  const openCrCount = openCrCountQuery.data?.change_requests.length ?? 0;

  const searchParams = useUiSearchParams();
  const pathname = useUiPathname();
  const shallowNavigate = useUiShallowNavigate();
  useEffect(() => {
    const cr = searchParams.get('cr');
    const requestedPanel = requestedFilesRightPanel(searchParams.get('panel'));
    if (!cr && !requestedPanel) return;
    if (cr) setCreatedCrId(cr);
    if (requestedPanel) setRightPanel(requestedPanel);
    const params = new URLSearchParams(searchParams.toString());
    params.delete('cr');
    params.delete('panel');
    const query = params.toString();
    // A shallow replace, not `router.replace`: the two lines above already
    // moved the params into React state, so the strip needs no server data.
    // Under Next.js `router.replace` would buy a cold RSC fetch for nothing;
    // `useUiShallowNavigate` writes `history.replaceState`, which Next observes,
    // and routes through the host router when it does not observe history.
    shallowNavigate(query ? `${pathname}?${query}` : pathname, { replace: true });
  }, [searchParams, pathname, shallowNavigate]);

  const isEmpty =
    !isLoading &&
    !error &&
    Boolean(files) &&
    !listing.hasNextPage &&
    elevatedDirs.length === 0 &&
    dirs.length === 0 &&
    fileItems.length === 0;

  return (
    <div className="bg-background relative flex h-full flex-col">
      <DriveHeader
        projectId={projectId || undefined}
        offsetForSidebarToggle={!embedded}
        historyToggle={{
          open: rightPanel === 'history',
          onToggle: () => toggleRightPanel('history'),
        }}
        reviewsToggle={{
          open: rightPanel === 'proposed-changes',
          onToggle: () => toggleRightPanel('proposed-changes'),
          openCount: openCrCount,
        }}
        onRefresh={() => refetchFiles()}
        onDownloadDir={() => {
          const dirName = isRootPath
            ? 'workspace'
            : currentPath.split('/').filter(Boolean).pop() || 'directory';
          const dirPath = isRootPath ? '/workspace' : currentPath;
          downloadDir(dirPath, dirName);
        }}
        isDownloading={isDirDownloading(isRootPath ? '/workspace' : currentPath)}
        showSearch={searchEnabled}
        sortDisabled={partial}
      />

      <div className="relative min-h-0 flex-1">
        <div className="absolute inset-0 overflow-y-auto">
          {isLoading && showSkeleton && <ListingSkeleton viewMode={viewMode} />}

          {!!error && !isLoading && (
            <ErrorState
              title={tHardcodedUi.raw(
                'featuresProjectFilesComponentsFileExplorerPage.line658JsxTextFailedToLoadFiles',
              )}
              description={
                error instanceof Error
                  ? error.message
                  : tHardcodedUi.raw('i18nComplete.text27c2ccd962c2')
              }
              action={
                <Button variant="outline" size="sm" onClick={() => refetchFiles()}>
                  {tHardcodedUi.raw('i18nComplete.text942087cc2d41')}
                </Button>
              }
            />
          )}

          {isEmpty && (
            <EmptyState
              icon={FolderOpen}
              title={tHardcodedUi.raw(
                'featuresProjectFilesComponentsDriveListView.line396JsxTextThisFolderIsEmpty',
              )}
              description={tHardcodedUi.raw(
                'featuresProjectFilesComponentsDriveListView.line398JsxTextNoFilesOrSubfoldersAtThisPathIn',
              )}
            />
          )}

          {!isLoading && !error && files && !isEmpty && (
            <>
              {viewMode === 'grid' ? (
                <DriveGridView
                  elevatedDirs={elevatedDirs}
                  dirs={dirs}
                  files={fileItems}
                  onNavigateToDir={handleNavigateToDir}
                  onOpenFile={handleOpenFile}
                  onPreviewFile={handlePreviewFile}
                  onDownload={handleDownload}
                  onDownloadDir={handleDownloadDir}
                  onHistory={handleHistory}
                  gitStatusMap={gitStatusMap}
                  isDirDownloading={isDirDownloading}
                />
              ) : (
                <DriveListView
                  elevatedDirs={elevatedDirs}
                  dirs={dirs}
                  files={fileItems}
                  sortDisabled={partial}
                  onNavigateToDir={handleNavigateToDir}
                  onOpenFile={handleOpenFile}
                  onPreviewFile={handlePreviewFile}
                  onDownload={handleDownload}
                  onDownloadDir={handleDownloadDir}
                  onHistory={handleHistory}
                  gitStatusMap={gitStatusMap}
                  isDirDownloading={isDirDownloading}
                />
              )}
              <LoadMoreRow listing={listing} />
            </>
          )}
        </div>

        <CheckpointsPanel open={rightPanel === 'history'} onClose={() => setRightPanel(null)} />

        <ChangeRequestsPanel
          open={rightPanel === 'proposed-changes'}
          onClose={() => setRightPanel(null)}
        />
      </div>

      <ChangeRequestDetailDialog
        crId={createdCrId}
        onClose={() => setCreatedCrId(null)}
        onOpenChangeRequest={setCreatedCrId}
      />

      <ExplorerFilePreview />
      {searchEnabled && isSearchOpen && <FileSearch />}

      {historyPopoverPath && (
        <div className="bg-popover border-border animate-in slide-in-from-bottom-4 fade-in-0 fixed right-4 bottom-4 z-50 overflow-hidden rounded-md border shadow-2xl duration-200">
          <FileHistoryPopoverContent
            filePath={historyPopoverPath}
            onClose={() => setHistoryPopoverPath(null)}
          />
        </div>
      )}
    </div>
  );
}
