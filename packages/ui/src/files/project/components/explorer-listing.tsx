'use client';

import { Skeleton } from '../../../primitives/skeleton';
import type { DroppedEntry } from '../drop-tree';
import type { GitStatusType } from '../../tree/components/file-tree-item';
import { useFilesStore, type ViewMode } from '../../../internal/stores/files-store';
import type { FileNode } from '../../../internal/files/types';
import { useMemo } from 'react';

/**
 * The listing core both explorers share (`DriveExplorer` and the read-only
 * `FileExplorerPage`): the sorted, partitioned rows, their loading skeleton,
 * and the props contract of the two views that render them.
 */

/** System directories always pinned at the top of the listing. */
const ELEVATED_DIRS = new Set(['.kortix']);

/** Sort and separate dirs and files, by the store's sort field and order. */
export function useSortedListing(files: FileNode[] | undefined, partial: boolean) {
  const sortBy = useFilesStore((s) => s.sortBy);
  const sortOrder = useFilesStore((s) => s.sortOrder);
  return useMemo(() => {
    if (!files)
      return {
        elevatedDirs: [] as FileNode[],
        dirs: [] as FileNode[],
        fileItems: [] as FileNode[],
      };

    const sortFn = (a: FileNode, b: FileNode) => {
      let cmp = 0;
      switch (sortBy) {
        case 'name':
          cmp = a.name.localeCompare(b.name);
          break;
        case 'type': {
          const extA = a.name.includes('.') ? a.name.split('.').pop() || '' : '';
          const extB = b.name.includes('.') ? b.name.split('.').pop() || '' : '';
          cmp = extA.localeCompare(extB);
          if (cmp === 0) cmp = a.name.localeCompare(b.name);
          break;
        }
        case 'modified':
        case 'size':
          cmp = a.name.localeCompare(b.name);
          break;
      }
      return sortOrder === 'desc' ? -cmp : cmp;
    };

    // A partial folder keeps the server's name order: a sorted subset would
    // put a later page's rows above the ones shown (KRTX-1723).
    const sorted = (nodes: FileNode[]) => (partial ? nodes : nodes.sort(sortFn));
    const allDirs = files.filter((f) => f.type === 'directory');
    const elevatedDirs = allDirs
      .filter((f) => ELEVATED_DIRS.has(f.name))
      .sort((a, b) => a.name.localeCompare(b.name));
    const dirs = sorted(allDirs.filter((f) => !ELEVATED_DIRS.has(f.name)));
    const fileItems = sorted(files.filter((f) => f.type === 'file'));
    return { elevatedDirs, dirs, fileItems };
  }, [files, sortBy, sortOrder, partial]);
}

/** The placeholder rows of a listing that is still loading. */
export function ListingSkeleton({ viewMode }: { viewMode: ViewMode }) {
  return (
    <div className="animate-in fade-in-0 p-4 duration-(--duration-moderate) motion-reduce:animate-none">
      {viewMode === 'grid' ? (
        <div className="space-y-6">
          <div>
            <Skeleton className="mb-3 h-4 w-16" />
            <div
              className="grid gap-2"
              style={{
                gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))",
              }}
            >
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={`f${i}`} className="h-10 rounded-lg" />
              ))}
            </div>
          </div>
          <div>
            <Skeleton className="mb-3 h-4 w-12" />
            <div
              className="grid gap-2.5"
              style={{
                gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))",
              }}
            >
              {Array.from({ length: 8 }).map((_, i) => (
                <Skeleton key={`fi${i}`} className="h-[138px] rounded-lg" />
              ))}
            </div>
          </div>
        </div>
      ) : (
        <div className="space-y-1">
          {Array.from({ length: 10 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-full rounded-sm" />
          ))}
        </div>
      )}
    </div>
  );
}

/** The props `DriveGridView` and `DriveListView` share. */
export interface DriveListingProps {
  elevatedDirs: FileNode[];
  dirs: FileNode[];
  files: FileNode[];
  onNavigateToDir: (node: FileNode) => void;
  onOpenFile: (node: FileNode) => void;
  onPreviewFile: (node: FileNode) => void;
  onDownload: (node: FileNode) => void;
  onDownloadDir: (node: FileNode) => void;
  onRename?: (node: FileNode, newName: string) => void;
  onDelete?: (node: FileNode) => void;
  onHistory: (node: FileNode) => void;
  onCopy?: (node: FileNode) => void;
  onCut?: (node: FileNode) => void;
  onDropMove?: (sourcePath: string, targetDirPath: string) => void;
  /** External files dropped onto a folder upload into THAT folder. */
  onDropUpload?: (files: File[], targetDirPath: string, entries?: DroppedEntry[]) => void;
  gitStatusMap: Map<string, GitStatusType>;
  clipboardPath?: string;
  clipboardOperation?: string;
  isDirDownloading: (path: string) => boolean;
  /** Hide mutation context-menu entries (delete/rename/cut/copy). */
  readOnly?: boolean;
  /** Folders that cannot be renamed, cut or deleted (see `ExplorerCapabilities.fixedAt`). */
  isFixed?: (path: string) => boolean;
  /** Paths still uploading. */
  uploadingPaths?: ReadonlySet<string>;
}

/** The write handlers a listing passes to its rows: none when it is `readOnly`. */
export function listingWriteHandlers(
  props: DriveListingProps,
): Pick<DriveListingProps, 'onRename' | 'onDelete' | 'onCopy' | 'onCut' | 'onDropMove' | 'onDropUpload'> {
  if (props.readOnly) return {};
  const { onRename, onDelete, onCopy, onCut, onDropMove, onDropUpload } = props;
  return { onRename, onDelete, onCopy, onCut, onDropMove, onDropUpload };
}
