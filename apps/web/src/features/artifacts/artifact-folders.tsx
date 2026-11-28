'use client';

import { useTranslations } from '@/i18n/use-translations';
import { suggestSpaceIcon } from '@kortix/shared';
import type { ArtifactFolder } from '@kortix/sdk';
import { useArtifactFolderMutations, useArtifactMutations } from '@kortix/sdk/react';
import { Button } from '@kortix/ui/button';
import { ConfirmDialog } from '@kortix/ui/confirm-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@kortix/ui/dropdown-menu';
import { EntityAvatar } from '@kortix/ui/entity-avatar';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@kortix/ui/input-group';
import { Label } from '@kortix/ui/label';
import Loading from '@kortix/ui/loading';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalDescription,
  ModalFooter,
  ModalHeader,
  ModalTitle,
} from '@kortix/ui/modal';
import { errorToast, successToast } from '@kortix/ui/toast';
import {
  ProjectIconField,
  type ProjectIconValue,
} from '@kortix/ui/workspace/projects/modal/project-icon-field';
import { CaretLeftIcon, DotsThreeIcon, FolderIcon, PencilSimpleIcon, TrashIcon } from '@phosphor-icons/react';
import { useRef, useState } from 'react';

import { isArtifactDrag, readArtifactDrag } from './artifact-card';
import { FolderMenuIcon, FolderTreeRadioItems, ROOT_FOLDER, folderSubtree } from './artifact-folder-tree';

/** The drag type of a folder tile. Its id rides in `draggedFolder`: a dragover cannot read the payload. */
const FOLDER_DRAG_TYPE = 'application/x-kortix-artifact-folder';
/** The folder being dragged, and where it may not land (itself and its subfolders). */
let draggedFolder: { id: string; parentId: string | null; blocked: Set<string> } | null = null;

/** A dragged folder may land on `target` (null: the root): not inside itself, not where it already is. */
function folderDropAllowed(event: React.DragEvent, target: string | null) {
  if (!event.dataTransfer.types.includes(FOLDER_DRAG_TYPE) || !draggedFolder) return false;
  if (target && draggedFolder.blocked.has(target)) return false;
  return draggedFolder.parentId !== target;
}

/**
 * A drop target for a dragged artifact card or folder tile: `folderId` null is
 * the root. It accepts only those two (not files or text), and a folder only
 * where it may go. It shows `over` while one hovers and moves it on drop.
 */
function useArtifactDropTarget(projectId: string, folderId: string | null, name: string) {
  const t = useTranslations('artifacts');
  const { update } = useArtifactMutations(projectId);
  const folderMutations = useArtifactFolderMutations(projectId);
  const [over, setOver] = useState(false);
  // dragenter/dragleave fire for every child: count them, so crossing a child does not flicker.
  const depth = useRef(0);
  const accepts = (event: React.DragEvent) => isArtifactDrag(event) || folderDropAllowed(event, folderId);
  const toast = { onSuccess: () => successToast(t('movedToFolder', { name })), onError: () => errorToast(t('moveFailed')) };
  return {
    over,
    pending: update.isPending || folderMutations.update.isPending,
    props: {
      onDragEnter: (event: React.DragEvent) => {
        if (!accepts(event)) return;
        event.preventDefault();
        depth.current += 1;
        setOver(true);
      },
      onDragOver: (event: React.DragEvent) => {
        if (!accepts(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
      },
      onDragLeave: (event: React.DragEvent) => {
        if (!accepts(event)) return;
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) setOver(false);
      },
      onDrop: (event: React.DragEvent) => {
        if (!accepts(event)) return;
        event.preventDefault();
        depth.current = 0;
        setOver(false);
        if (folderDropAllowed(event, folderId)) {
          const moving = draggedFolder!.id;
          draggedFolder = null;
          folderMutations.update.mutate({ folderId: moving, parent_folder_id: folderId }, toast);
          return;
        }
        const drag = readArtifactDrag(event);
        if (!drag || drag.folderId === folderId) return;
        update.mutate({ artifactId: drag.artifactId, folder_id: folderId }, toast);
      },
    },
  };
}

export function ArtifactFolderEditor({
  projectId,
  folder,
  parent = null,
  onClose,
}: {
  projectId: string;
  folder?: ArtifactFolder;
  /** A new folder is created inside this one (null: the gallery root). */
  parent?: ArtifactFolder | null;
  onClose: () => void;
}) {
  const t = useTranslations('artifacts');
  const mutations = useArtifactFolderMutations(projectId);
  const [name, setName] = useState(folder?.name ?? '');
  const [icon, setIcon] = useState<ProjectIconValue>(
    folder?.icon_glyph
      ? { glyph: folder.icon_glyph }
      : folder?.icon
        ? { emoji: folder.icon }
        : null,
  );
  const displayedIcon = icon ?? (name.trim() ? suggestSpaceIcon(name) : { glyph: { name: 'Folder', color: 'grey' } });
  const pending = mutations.create.isPending || mutations.update.isPending;
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const input = {
      name: name.trim(),
      icon: 'emoji' in displayedIcon ? displayedIcon.emoji : null,
      icon_glyph: 'glyph' in displayedIcon ? displayedIcon.glyph : null,
    };
    try {
      if (folder) await mutations.update.mutateAsync({ folderId: folder.folder_id, ...input });
      else await mutations.create.mutateAsync({ ...input, parent_folder_id: parent?.folder_id ?? null });
      successToast(t(folder ? 'folderSaved' : 'folderCreated'));
      onClose();
    } catch {
      errorToast(t('folderSaveFailed'));
    }
  };
  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <ModalContent className="lg:max-w-sm">
        <ModalHeader>
          <ModalTitle>{t(folder ? 'editFolder' : 'newFolder')}</ModalTitle>
          {/* A subfolder says where it lands: the open folder, with its own icon. */}
          {!folder && parent ? (
            <ModalDescription className="flex min-w-0 items-center gap-1.5">
              <span className="shrink-0">{t('folderCreateIn')}</span>
              <FolderMenuIcon folder={parent} />
              <span className="text-foreground truncate font-medium" title={parent.name}>{parent.name}</span>
            </ModalDescription>
          ) : null}
        </ModalHeader>
        <form onSubmit={submit}>
          <ModalBody>
            <Label htmlFor="artifact-folder-name" className="sr-only">{t('folderName')}</Label>
            <InputGroup className="h-12">
              <InputGroupAddon className="pl-1.5 has-[>button]:ml-0">
                <ProjectIconField
                  ariaLabel={t('folderIcon')}
                  value={displayedIcon}
                  onChange={(emoji) => setIcon({ emoji })}
                  onGlyphChange={(glyph) => setIcon({ glyph })}
                  onClear={icon ? () => setIcon(null) : undefined}
                  disabled={pending}
                  triggerClassName="size-9 border-0 shadow-none"
                />
              </InputGroupAddon>
              <InputGroupInput
                id="artifact-folder-name"
                autoFocus
                required
                maxLength={100}
                placeholder={t('folderName')}
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={pending}
              />
            </InputGroup>
          </ModalBody>
          <ModalFooter>
            <Button type="button" variant="outline-ghost" onClick={onClose} disabled={pending}>
              {t('cancel')}
            </Button>
            <Button type="submit" disabled={pending || !name.trim()} aria-busy={pending}>
              {pending ? <Loading className="size-4" /> : null}
              {t(folder ? 'saveFolder' : 'createFolder')}
            </Button>
          </ModalFooter>
        </form>
      </ModalContent>
    </Modal>
  );
}

export function ArtifactFolderTile({
  folder,
  folders,
  projectId,
  onOpen,
}: {
  folder: ArtifactFolder;
  /** Every folder: what a drag of this one may not land in. */
  folders: ArtifactFolder[];
  projectId: string;
  onOpen: () => void;
}) {
  const drop = useArtifactDropTarget(projectId, folder.folder_id, folder.name);
  const [dragging, setDragging] = useState(false);
  return (
    <div
      {...drop.props}
      // Drag a folder onto another folder (or a crumb) to nest it there.
      draggable={folder.can_manage}
      onDragStart={(event) => {
        event.dataTransfer.setData(FOLDER_DRAG_TYPE, folder.folder_id);
        event.dataTransfer.effectAllowed = 'move';
        draggedFolder = {
          id: folder.folder_id,
          parentId: folder.parent_folder_id ?? null,
          blocked: folderSubtree(folders, folder.folder_id),
        };
        setDragging(true);
      }}
      onDragEnd={() => {
        draggedFolder = null;
        setDragging(false);
      }}
      data-drop-over={drop.over || undefined}
      aria-busy={drop.pending || undefined}
      className={`bg-secondary/50 data-[drop-over]:bg-secondary data-[drop-over]:ring-ring flex min-w-0 items-center gap-2 rounded-md px-3 py-2 transition-[background-color,opacity] data-[drop-over]:ring-2 ${dragging ? 'opacity-40' : ''}`}
    >
      <button
        type="button"
        className="focus-visible:outline-ring flex min-h-11 min-w-0 flex-1 items-center gap-3 rounded-md text-start focus-visible:outline-2"
        onClick={onOpen}
      >
        <EntityAvatar
          emoji={folder.icon}
          glyph={folder.icon_glyph}
          icon={FolderIcon}
          label={folder.name}
          size="md"
        />
        <span className="truncate text-sm font-medium" title={folder.name}>
          {folder.name}
        </span>
        {drop.pending ? <Loading className="text-muted-foreground ms-auto size-3.5 shrink-0" /> : null}
      </button>
      <ArtifactFolderActions folder={folder} folders={folders} projectId={projectId} />
    </div>
  );
}

/** A crumb above a folder's contents: it opens that level, and a card or folder dropped on it moves there. */
export function ArtifactFolderCrumb({
  projectId,
  folderId,
  name,
  onOpen,
  back = false,
}: {
  projectId: string;
  /** null: the gallery root. */
  folderId: string | null;
  name: string;
  onOpen: () => void;
  /** The crumb a phone keeps: there it is a back arrow, named for screen readers. */
  back?: boolean;
}) {
  const drop = useArtifactDropTarget(projectId, folderId, name);
  // A header crumb, as on Goals: muted text that opens its level; a drop ring while a card or folder hovers.
  return (
    <button
      type="button"
      {...drop.props}
      onClick={onOpen}
      data-drop-over={drop.over || undefined}
      aria-busy={drop.pending || undefined}
      // No padding: the text lines up with the page title it replaces. The hit
      // area, focus ring and drop highlight are an ::after around the text,
      // painted behind it (`isolate` keeps -z inside the button).
      className="text-muted-foreground hover:text-foreground data-[drop-over]:text-foreground focus-visible:after:ring-ring data-[drop-over]:after:bg-secondary data-[drop-over]:after:ring-ring relative isolate flex max-w-40 min-w-0 shrink items-center gap-1 text-sm outline-none after:absolute after:-inset-x-2 after:-inset-y-2.5 after:-z-10 after:rounded-md after:content-[''] focus-visible:after:ring-2 data-[drop-over]:after:ring-2"
    >
      {drop.pending ? <Loading className="size-3.5 shrink-0" /> : back ? <CaretLeftIcon className="size-4 shrink-0 sm:hidden" aria-hidden /> : null}
      <span className={back ? 'max-sm:sr-only truncate' : 'truncate'} title={name}>{name}</span>
    </button>
  );
}

export function ArtifactFolderActions({
  folder,
  folders,
  projectId,
}: {
  folder: ArtifactFolder;
  folders: ArtifactFolder[];
  projectId: string;
}) {
  const t = useTranslations('artifacts');
  const mutations = useArtifactFolderMutations(projectId);
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  return (<>
      {folder.can_manage ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={t('folderActions', { name: folder.name })}
            >
              <DotsThreeIcon className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => setEditing(true)}>
              <PencilSimpleIcon />
              {t('editFolder')}
            </DropdownMenuItem>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <FolderIcon /> {t('moveToFolder')}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="max-h-[var(--radix-dropdown-menu-content-available-height)] max-w-64 overflow-y-auto">
                <FolderTreeRadioItems
                  folders={folders}
                  value={folder.parent_folder_id ?? ROOT_FOLDER}
                  exclude={folderSubtree(folders, folder.folder_id)}
                  onValueChange={(parent) => {
                    const name = parent ? folders.find((f) => f.folder_id === parent)?.name : t('title');
                    mutations.update.mutate(
                      { folderId: folder.folder_id, parent_folder_id: parent },
                      {
                        onSuccess: () => successToast(t('movedToFolder', { name: name ?? t('title') })),
                        onError: () => errorToast(t('moveFailed')),
                      },
                    );
                  }}
                />
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={() => setRemoving(true)}>
              <TrashIcon />
              {t('deleteFolder')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      {editing ? (
        <ArtifactFolderEditor
          projectId={projectId}
          folder={folder}
          onClose={() => setEditing(false)}
        />
      ) : null}
      <ConfirmDialog
        open={removing}
        onOpenChange={setRemoving}
        title={t('deleteFolderTitle', { name: folder.name })}
        description={t('deleteFolderHint')}
        isPending={mutations.remove.isPending}
        confirmVariant="destructive"
        confirmLabel={t('deleteFolder')}
        onConfirm={async () => {
          try {
            await mutations.remove.mutateAsync(folder.folder_id);
            successToast(t('folderDeleted'));
            setRemoving(false);
          } catch {
            errorToast(t('folderDeleteFailed'));
          }
        }}
      />
  </>);
}
