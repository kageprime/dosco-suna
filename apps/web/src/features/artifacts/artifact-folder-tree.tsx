'use client';

import type { ArtifactFolder } from '@kortix/sdk';
import { useArtifactFolders } from '@kortix/sdk/react';
import { BreadcrumbItem, BreadcrumbLink, BreadcrumbSeparator } from '@kortix/ui/breadcrumb';
import { Button } from '@kortix/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuRadioGroup,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
} from '@kortix/ui/dropdown-menu';
import { glyphFace } from '@kortix/ui/glyph-face';
import { glyphForeground, glyphStyle } from '@kortix/ui/glyph-tint';
import { CaretRightIcon, DotsThreeIcon, FolderIcon, FolderSimpleDashedIcon } from '@phosphor-icons/react';
import Link from 'next/link';
import { Fragment, createElement, type ReactNode } from 'react';

import { useTranslations } from '@/i18n/use-translations';

/**
 * A folder's icon alone, at menu-icon size: its glyph in its own colour, its
 * emoji, or a plain folder. No tile: in a menu row the icon sits beside the
 * name like every other menu icon.
 */
export function FolderMenuIcon({ folder }: { folder: ArtifactFolder }) {
  const Glyph = folder.icon_glyph ? glyphFace(folder.icon_glyph.name) : null;
  if (Glyph && folder.icon_glyph) {
    // createElement: the glyph is looked up by name, not a component declared here.
    return createElement(Glyph, {
      weight: 'fill',
      'aria-hidden': true,
      className: `size-4 shrink-0 ${glyphForeground(folder.icon_glyph.color)}`,
      style: glyphStyle(folder.icon_glyph.color),
    });
  }
  if (folder.icon) {
    return (
      <span aria-hidden className="flex size-4 shrink-0 items-center justify-center text-sm leading-none">
        {folder.icon}
      </span>
    );
  }
  return <FolderIcon aria-hidden className="text-muted-foreground size-4 shrink-0" />;
}

/** The gallery root in a folder picker's radio value. */
export const ROOT_FOLDER = 'root';

/** The folders directly inside `parentId` (null: the gallery root), in the API's name order. */
export function folderChildren(folders: ArtifactFolder[], parentId: string | null) {
  return folders.filter((folder) => (folder.parent_folder_id ?? null) === parentId);
}

/** `id` and its ancestors, root first. Bounded, so a corrupt tree cannot loop. */
export function folderPath(folders: ArtifactFolder[], id: string | null): ArtifactFolder[] {
  const byId = new Map(folders.map((folder) => [folder.folder_id, folder]));
  const path: ArtifactFolder[] = [];
  for (let at = id ? byId.get(id) : undefined; at && path.length <= folders.length; at = at.parent_folder_id ? byId.get(at.parent_folder_id) : undefined) {
    path.unshift(at);
  }
  return path;
}

/** `id` and every folder below it: where that folder may not move. */
export function folderSubtree(folders: ArtifactFolder[], id: string): Set<string> {
  const subtree = new Set([id]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const folder of folders) {
      if (folder.parent_folder_id && subtree.has(folder.parent_folder_id) && !subtree.has(folder.folder_id)) {
        subtree.add(folder.folder_id);
        grew = true;
      }
    }
  }
  return subtree;
}

const SUB_CONTENT = 'max-h-[var(--radix-dropdown-menu-content-available-height)] max-w-64 overflow-y-auto';

function FolderRow({ folder }: { folder: ArtifactFolder }) {
  return (
    <>
      <FolderMenuIcon folder={folder} />
      <span className="truncate" title={folder.name}>
        {folder.name}
      </span>
    </>
  );
}

/**
 * The rows of a "Move to folder" submenu: No folder, then the root folders.
 * A folder with subfolders opens its own submenu: the folder itself first
 * (pick it to move there), then its subfolders, the same way down. One radio
 * group spans every level, so the current folder carries the check wherever
 * it sits. `exclude` hides folders a folder cannot move into (itself and its
 * subfolders).
 */
export function FolderTreeRadioItems({
  folders,
  value,
  onValueChange,
  exclude = new Set(),
}: {
  folders: ArtifactFolder[];
  /** The current folder id, or `ROOT_FOLDER`. */
  value: string;
  onValueChange: (folderId: string | null) => void;
  exclude?: Set<string>;
}) {
  const t = useTranslations('artifacts');
  const childrenOf = (parentId: string | null) =>
    folderChildren(folders, parentId).filter((folder) => !exclude.has(folder.folder_id));
  const level = (parentId: string | null): ReactNode =>
    childrenOf(parentId).map((folder) =>
      childrenOf(folder.folder_id).length ? (
        <DropdownMenuSub key={folder.folder_id}>
          <DropdownMenuSubTrigger>
            <FolderRow folder={folder} />
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className={SUB_CONTENT}>
            <DropdownMenuRadioItem value={folder.folder_id} textValue={folder.name}>
              <FolderRow folder={folder} />
            </DropdownMenuRadioItem>
            <DropdownMenuSeparator />
            {level(folder.folder_id)}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      ) : (
        <DropdownMenuRadioItem key={folder.folder_id} value={folder.folder_id} textValue={folder.name}>
          <FolderRow folder={folder} />
        </DropdownMenuRadioItem>
      ),
    );
  const roots = childrenOf(null);
  return (
    <DropdownMenuRadioGroup
      value={value}
      onValueChange={(next) => {
        if (next !== value) onValueChange(next === ROOT_FOLDER ? null : next);
      }}
    >
      <DropdownMenuRadioItem value={ROOT_FOLDER} textValue={t('folderRoot')}>
        <FolderSimpleDashedIcon aria-hidden className="text-muted-foreground size-4 shrink-0" />
        <span className="truncate">{t('folderRoot')}</span>
      </DropdownMenuRadioItem>
      {roots.length ? <DropdownMenuSeparator /> : null}
      {level(null)}
    </DropdownMenuRadioGroup>
  );
}

/** Up to this many folders show in full; a longer path keeps the first and the last. */
const FULL_PATH = 3;

function folderHref(projectId: string, folderId: string) {
  return `/workspaces/${projectId}/artifacts?folder=${encodeURIComponent(folderId)}`;
}

function PathSeparator({ className }: { className?: string }) {
  return (
    <BreadcrumbSeparator className={className}>
      <CaretRightIcon />
    </BreadcrumbSeparator>
  );
}

/** A ⋯ crumb: a menu of the folders it stands for, top first, each with its icon. */
function CollapsedFolders({ projectId, folders, className }: { projectId: string; folders: ArtifactFolder[]; className?: string }) {
  const t = useTranslations('artifacts');
  return (
    <BreadcrumbItem className={className}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label={t('folderPathMore')} className="text-muted-foreground -mx-1.5 shrink-0">
            <DotsThreeIcon className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-w-64">
          {folders.map((folder) => (
            <DropdownMenuItem key={folder.folder_id} asChild>
              <Link href={folderHref(projectId, folder.folder_id)}>
                <FolderMenuIcon folder={folder} />
                <span className="truncate" title={folder.name}>
                  {folder.name}
                </span>
              </Link>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </BreadcrumbItem>
  );
}

/**
 * The folders an artifact sits in, as breadcrumb items after "Artifacts ›":
 * each opens its folder in the gallery. A path longer than three keeps the
 * first and the last and folds the middle into a ⋯ menu; a phone folds every
 * folder into that menu, so the artifact's title keeps the room.
 */
export function ArtifactFolderPath({ projectId, folderId }: { projectId: string; folderId: string | null | undefined }) {
  const folders = useArtifactFolders(projectId);
  const path = folderPath(folders.data ?? [], folderId ?? null);
  if (!path.length) return null;
  const folded = path.length > FULL_PATH ? path.slice(1, -1) : [];
  const shown = path.length > FULL_PATH ? [path[0]!, null, path[path.length - 1]!] : path;
  return (
    <>
      {/* Phone: one ⋯ for the whole path. */}
      <CollapsedFolders projectId={projectId} folders={path} className="sm:hidden" />
      <PathSeparator className="sm:hidden" />
      {shown.map((folder, index) =>
        folder ? (
          <Fragment key={folder.folder_id}>
            <BreadcrumbItem className="hidden max-w-40 min-w-0 sm:inline-flex">
              <BreadcrumbLink asChild>
                <Link href={folderHref(projectId, folder.folder_id)} className="truncate" title={folder.name}>
                  {folder.name}
                </Link>
              </BreadcrumbLink>
            </BreadcrumbItem>
            <PathSeparator className="hidden sm:list-item" />
          </Fragment>
        ) : (
          <Fragment key={`folded-${index}`}>
            <CollapsedFolders projectId={projectId} folders={folded} className="hidden sm:inline-flex" />
            <PathSeparator className="hidden sm:list-item" />
          </Fragment>
        ),
      )}
    </>
  );
}
