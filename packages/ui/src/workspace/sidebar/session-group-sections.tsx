'use client';

/**
 * Session groups in the sidebar (`session_groups` flag): the project's shared,
 * named folders of sessions, between Pinned and the rest of the list.
 *
 * Each group is a section header like Pinned's (no icon). Its rows load when it is open (one paged list per
 * group, any starter, any depth), and its open state is the viewer's own,
 * beside the other sections in the session-filter store. A session moves into
 * a group from its `⋯` menu or by dragging its row onto the group; a group
 * moves by dragging its header onto another group, or with Move up / Move
 * down. Dragging a row onto the rest of the list takes it out of its group.
 */

import { ApiError, type ProjectSession, type ProjectSessionGroup } from '@kortix/sdk';
import {
  findCachedProjectSession,
  useCreateProjectSessionGroup,
  useDeleteProjectSessionGroup,
  useProjectSessions,
  useReorderProjectSessionGroups,
  useSetProjectSessionGroup,
} from '@kortix/sdk/react';
import { useQueryClient } from '@tanstack/react-query';
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ArrowsInLineVerticalIcon,
  DotsThreeIcon,
  PencilSimpleIcon,
  PlusIcon,
  StackIcon,
  TrashIcon,
} from '@phosphor-icons/react';
import { useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode, type SyntheticEvent } from 'react';

import { useTranslations } from '../../i18n';
import { cn } from '../../internal/lib/utils';
import { Button } from '../../primitives/button';
import { ConfirmDialog } from '../../primitives/confirm-dialog';
import { Disclosure, DisclosureContent, DisclosureTrigger } from '../../primitives/disclosure';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../../primitives/dropdown-menu';
import Hint from '../../primitives/hint';
import { errorToast, successToast } from '../../primitives/toast';
import { moveGroupBy, moveGroupTo } from './session-group-order';
import { SpaceIconBare } from '../session-spaces/space-icon';
import {
  SESSION_MENU_TRIGGER_CLASS,
  SESSION_ROW_HEIGHT_CLASS,
  SIDEBAR_PAGE_SIZE,
  ShowMoreButton,
} from '../../session/list/session-list-chrome';
import { CaretRightSolidIcon } from '../../icons/caret-right-solid';
import { uiRoutes } from '../../lib/routes';
import { UiLink, useUiPathname, useUiRouter } from '../../providers/ui-provider';

/** A dragged session row carries its id under this type. */
const SESSION_DRAG_TYPE = 'application/x-kortix-session';
/** A dragged group header carries its id under this type. */
const GROUP_DRAG_TYPE = 'application/x-kortix-session-group';
/** Mirrors `SESSION_GROUP_NAME_MAX` in `@kortix/api-contract`: the server refuses a longer name. */
const GROUP_NAME_MAX = 80;

/**
 * The group header being dragged in this window, if any. `dataTransfer` data is
 * unreadable during `dragover`, and the drop line needs to know whether the
 * dragged group lands above or below the one under the pointer.
 */
let draggingGroupId: string | null = null;

/**
 * Set by a menu's "New group" just before the menu closes: that close must not
 * hand focus back to the menu trigger, or it would pull focus out of the new
 * group's name field the moment it appears. Read and cleared by
 * `keepFocusForNewGroup` in the menu's `onCloseAutoFocus`.
 */
let newGroupTakesFocus = false;

/** Call before opening the new-group row from a menu item. */
export function markNewGroupFocus(): void {
  newGroupTakesFocus = true;
}

/** `onCloseAutoFocus` of a menu with a "New group" item. */
export function keepFocusForNewGroup(event: Event): void {
  if (!newGroupTakesFocus) return;
  newGroupTakesFocus = false;
  event.preventDefault();
}

/** Keeps a click or key inside a group's menu or dialog (portals bubble through React) off the header's toggle. */
const stopAtMenu = (event: SyntheticEvent) => event.stopPropagation();

/**
 * The sections-state id of one space. Spaces start collapsed: the id in the
 * set means the space is open (unlike Pinned and Sessions, where it means closed).
 */
export function sessionGroupSectionId(groupId: string): string {
  return `group:${groupId}`;
}

/** `onDragStart` of a session row: the row's link drag also carries the session id. */
export function startSessionDrag(event: DragEvent, sessionId: string): void {
  event.dataTransfer.setData(SESSION_DRAG_TYPE, sessionId);
  // A link drag allows only copy and link by default; a drop here is a move.
  event.dataTransfer.effectAllowed = 'all';
}

function dragCarries(event: DragEvent, type: string): boolean {
  return Array.from(event.dataTransfer.types).includes(type);
}

/**
 * A drop target for dragged session rows (and, with `onDropGroup`, dragged
 * group headers). `over` is what is over it right now, for the highlight.
 */
function useDropTarget(handlers: { onDropSession?: (sessionId: string) => void; onDropGroup?: (groupId: string) => void }) {
  const [over, setOver] = useState<'session' | 'group' | null>(null);
  const kindOf = (event: DragEvent) =>
    handlers.onDropSession && dragCarries(event, SESSION_DRAG_TYPE)
      ? 'session'
      : handlers.onDropGroup && dragCarries(event, GROUP_DRAG_TYPE)
        ? 'group'
        : null;
  const props = {
    onDragOver: (event: DragEvent) => {
      const kind = kindOf(event);
      if (!kind) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      if (over !== kind) setOver(kind);
    },
    onDragLeave: (event: DragEvent) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(null);
    },
    onDrop: (event: DragEvent) => {
      const kind = kindOf(event);
      setOver(null);
      if (!kind) return;
      event.preventDefault();
      if (kind === 'session') handlers.onDropSession?.(event.dataTransfer.getData(SESSION_DRAG_TYPE));
      else handlers.onDropGroup?.(event.dataTransfer.getData(GROUP_DRAG_TYPE));
    },
  };
  return { over, props };
}

/** Filing and reordering, with their result toasts. One instance per list. */
export function useSessionGroupActions(projectId: string, groups: readonly ProjectSessionGroup[]) {
  const t = useTranslations('sidebar.sessionGroups');
  const queryClient = useQueryClient();
  const { mutateAsync: file } = useSetProjectSessionGroup(projectId);
  const { mutateAsync: reorder } = useReorderProjectSessionGroups(projectId);
  return useMemo(() => {
    const nameOf = (groupId: string | null) =>
      groupId ? (groups.find((group) => group.group_id === groupId)?.name ?? '') : t('noGroup');
    return {
      /** `toast`: a menu move reports where the row went; a drop shows it in place. */
      move: async (sessionId: string, groupId: string | null, options?: { toast?: boolean }) => {
        // A drop on the row's own group (or of an ungrouped row on the list) changes nothing.
        const cached = findCachedProjectSession(queryClient, projectId, (session) => session.session_id === sessionId);
        if (cached && (cached.group_id ?? null) === groupId) return;
        try {
          await file({ sessionId, groupId });
          if (options?.toast) successToast(t('moved'), { description: nameOf(groupId) });
        } catch {
          errorToast(t('moveFailed'));
        }
      },
      reorder: async (groupIds: string[] | null) => {
        if (!groupIds) return;
        try {
          await reorder(groupIds);
        } catch {
          errorToast(t('reorderFailed'));
        }
      },
    };
  }, [file, reorder, groups, t, queryClient, projectId]);
}

/** `base`, or `base 2`, `base 3`…: the first name no group of the project has (names are unique per project). */
export function nextSessionGroupName(groups: readonly ProjectSessionGroup[], base: string): string {
  const taken = new Set(groups.map((group) => group.name.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  let n = 2;
  while (taken.has(`${base} ${n}`.toLowerCase())) n += 1;
  return `${base} ${n}`;
}

/**
 * A new group, named in place: the row a group header takes, holding an input
 * with `defaultName` selected. Enter or a click elsewhere creates it; Escape,
 * or an empty name, drops the row. A taken name or the group limit shows as a
 * toast and keeps the row open. `onDone` gets the new group, or null.
 */
export function NewSessionGroupRow({
  projectId,
  defaultName,
  onDone,
}: {
  projectId: string;
  defaultName: string;
  onDone: (group: ProjectSessionGroup | null) => void;
}) {
  const t = useTranslations('sidebar.sessionGroups');
  const create = useCreateProjectSessionGroup(projectId);
  const [value, setValue] = useState(defaultName);
  // A ref, not `isPending`: Enter and the blur that follows land in one render.
  const busy = useRef(false);
  const done = useRef(false);
  const rowRef = useRef<HTMLDivElement>(null);

  const finish = (group: ProjectSessionGroup | null) => {
    done.current = true;
    onDone(group);
  };
  const commit = async () => {
    if (busy.current || done.current) return;
    const name = value.trim();
    if (!name) return finish(null);
    busy.current = true;
    try {
      finish(await create.mutateAsync({ name }));
    } catch (error) {
      const code = error instanceof ApiError ? error.code : undefined;
      errorToast(code === 'group_name_taken' ? t('nameTaken') : code === 'group_limit' ? t('limit') : t('createFailed'));
    } finally {
      busy.current = false;
    }
  };

  // A click anywhere else creates the group (a blur would also fire when a
  // closing menu or a toast moves focus, which is not the viewer leaving).
  const commitRef = useRef(commit);
  commitRef.current = commit;
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!rowRef.current?.contains(event.target as Node)) void commitRef.current();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, []);

  return (
    <div ref={rowRef} className="space-y-1" data-session-group-draft>
      <div className={cn('flex items-center px-1', SESSION_ROW_HEIGHT_CLASS)}>
        <input
          autoFocus
          value={value}
          maxLength={GROUP_NAME_MAX}
          aria-label={t('namePlaceholder')}
          placeholder={t('namePlaceholder')}
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === 'Enter') {
              event.preventDefault();
              void commit();
            } else if (event.key === 'Escape') {
              event.preventDefault();
              finish(null);
            }
          }}
          className="border-input bg-background text-sidebar-foreground placeholder:text-muted-foreground focus-visible:border-ring h-7 w-full min-w-0 rounded-md border px-1.5 text-sm font-medium outline-none"
        />
      </div>
      <p className="text-muted-foreground flex h-8 items-center px-2 text-xs">
        <span className="truncate">{t('empty')}</span>
      </p>
    </div>
  );
}

/**
 * The Spaces heading over the spaces: its label opens the Spaces page, its "+"
 * (on hover) names a new space in place, like the Sessions header's controls.
 */
export function SpacesHeading({ projectId, onNew }: { projectId: string; onNew: () => void }) {
  const tGroups = useTranslations('sidebar.sessionGroups');
  const href = uiRoutes().sessionSpaces?.(projectId) ?? null;
  const label = 'text-muted-foreground group-hover/spaces-header:text-sidebar-foreground min-w-0 flex-1 truncate text-sm font-medium';
  return (
    <div className={cn('group/spaces-header hover:bg-sidebar-row flex items-center gap-1 rounded-md px-2 transition-colors', SESSION_ROW_HEIGHT_CLASS)}>
      {href ? (
        <Hint label={tGroups('allSpaces')} side="right">
          <UiLink href={href} prefetch={false} className={cn(label, 'self-stretch leading-8 focus-visible:outline-none')}>
            {tGroups('heading')}
          </UiLink>
        </Hint>
      ) : (
        <span className={label}>{tGroups('heading')}</span>
      )}
      <Hint label={tGroups('newGroup')} side="right">
        <Button
          variant="ghost"
          size="icon-xs"
          type="button"
          aria-label={tGroups('newGroup')}
          onClick={() => {
            markNewGroupFocus();
            onNew();
          }}
          className={cn(
            SESSION_MENU_TRIGGER_CLASS,
            'relative opacity-0 before:absolute before:-inset-1',
            'group-hover/spaces-header:opacity-100 focus-visible:opacity-100',
          )}
        >
          <PlusIcon className="size-4" />
        </Button>
      </Hint>
    </div>
  );
}

interface SessionGroupSectionsProps {
  projectId: string;
  groups: readonly ProjectSessionGroup[];
  /** The Labels facet, sent to every group's list like the main list's. */
  labels: string[] | undefined;
  collapsedSectionIds: ReadonlySet<string>;
  onToggleSection: (sectionId: string) => void;
  /** The status and source facets, applied to each group's rows. */
  passesFacets: (session: ProjectSession) => boolean;
  renderNode: (session: ProjectSession) => ReactNode;
  actions: ReturnType<typeof useSessionGroupActions>;
  onRename: (group: ProjectSessionGroup) => void;
  /** Open the New group dialog. */
  onNewGroup: () => void;
  /** Close every group except this one; this one stays open. */
  onCollapseOthers: (groupId: string) => void;
}

/** Every group of the project, in order. */
export function SessionGroupSections({ groups, ...rest }: SessionGroupSectionsProps) {
  const groupIds = groups.map((group) => group.group_id);
  return (
    <>
      {groups.map((group) => (
        <SessionGroupSection key={group.group_id} group={group} groupIds={groupIds} {...rest} />
      ))}
    </>
  );
}

function SessionGroupSection({
  projectId,
  group,
  groupIds,
  labels,
  collapsedSectionIds,
  onToggleSection,
  passesFacets,
  renderNode,
  actions,
  onRename,
  onNewGroup,
  onCollapseOthers,
}: Omit<SessionGroupSectionsProps, 'groups'> & { group: ProjectSessionGroup; groupIds: string[] }) {
  const t = useTranslations('sidebar');
  const tGroups = useTranslations('sidebar.sessionGroups');
  const sectionId = sessionGroupSectionId(group.group_id);
  const open = collapsedSectionIds.has(sectionId);
  const spaceHref = uiRoutes().sessionSpace?.(projectId, group.group_id) ?? null;
  // The space whose page is open reads as the current row, as a nav row does.
  const pathname = useUiPathname();
  const current = !!spaceHref && !!pathname && pathname.endsWith(spaceHref);
  // Any starter and any depth, like Pinned: a session is in a group because
  // someone put it there. Loaded only while the group is open.
  const query = useProjectSessions(projectId, {
    group: group.group_id,
    labels,
    limit: SIDEBAR_PAGE_SIZE,
    enabled: open,
    // No focus refetch: a project with dozens of open groups would refetch
    // every one of them. A session started in a space refetches these lists
    // itself (`use-project-home-send.ts`).
    refetchOnWindowFocus: false,
  });
  // A pinned row shows under Pinned only. The `group_id` check drops a row the
  // viewer just moved out, before the refetch lands.
  const rows = query.sessions.filter(
    (session) => session.group_id === group.group_id && !session.pinned_at && passesFacets(session),
  );
  const index = groupIds.indexOf(group.group_id);
  const drop = useDropTarget({
    onDropSession: (sessionId) => void actions.move(sessionId, group.group_id),
    onDropGroup: (groupId) => void actions.reorder(moveGroupTo(groupIds, groupId, index)),
  });

  return (
    <div {...drop.props} data-session-group={group.group_id}>
      <Disclosure
        open={open}
        onOpenChange={() => onToggleSection(sectionId)}
        className="group/section space-y-1"
        transition={{ duration: 0.15, ease: 'easeOut' }}
      >
        <div
          draggable
          onDragStart={(event) => {
            event.dataTransfer.setData(GROUP_DRAG_TYPE, group.group_id);
            event.dataTransfer.effectAllowed = 'move';
            draggingGroupId = group.group_id;
          }}
          onDragEnd={() => {
            draggingGroupId = null;
          }}
          className={cn(
            // A space reads like a nav row (Inbox, Drive): a 16px glyph slot, then its name, which opens the space.
            // The glyph turns into the caret on hover; the caret folds the space's sessions under it.
            'group/section-header text-sidebar-foreground/80 hover:bg-sidebar-row hover:text-sidebar-foreground relative flex items-center gap-2 rounded-md px-2 text-sm',
            SESSION_ROW_HEIGHT_CLASS,
            current && 'bg-active text-sidebar-accent-foreground font-medium hover:bg-active',
            drop.over === 'session' && 'bg-sidebar-row text-sidebar-foreground',
            // A group dropped here takes this place: a line marks the side it
            // lands on (below this group when it comes from above).
            drop.over === 'group' &&
              'before:bg-foreground/40 before:absolute before:inset-x-2 before:h-0.5 before:rounded-full',
            drop.over === 'group' &&
              (groupIds.indexOf(draggingGroupId ?? '') < index ? 'before:bottom-0' : 'before:top-0'),
          )}
        >
          <DisclosureTrigger>
            <button
              type="button"
              aria-label={`${open ? tGroups('hideSessions') : tGroups('showSessions')}: ${group.name}`}
              className="text-muted-foreground hover:text-sidebar-foreground hit-area-1.5 flex size-4 shrink-0 items-center justify-center rounded-sm"
            >
              {/* No tile: the glyph alone, 18px in the 15px slot. -mx-0.5 overhangs
                  both sides equally, so the name keeps the sessions' text edge. */}
              <SpaceIconBare
                space={group}
                className="-mx-0.5 size-5 group-hover/section-header:hidden group-focus-within/section-header:hidden"
              />
              <CaretRightSolidIcon
                aria-hidden
                className="duration-normal hidden size-4 transition-transform ease-out group-hover/section-header:block group-focus-within/section-header:block group-data-[state=open]/section:rotate-90"
              />
            </button>
          </DisclosureTrigger>
          {spaceHref ? (
            <UiLink
              href={spaceHref}
              prefetch={false}
              aria-current={current ? 'page' : undefined}
              className="min-w-0 flex-1 truncate self-stretch leading-8 first-letter:uppercase focus-visible:outline-none"
            >
              {group.name}
            </UiLink>
          ) : (
            <span className="min-w-0 flex-1 truncate first-letter:uppercase">{group.name}</span>
          )}
          <SessionGroupMenu
            group={group}
            onRename={() => onRename(group)}
            onNewGroup={onNewGroup}
            onCollapseOthers={groupIds.length > 1 ? () => onCollapseOthers(group.group_id) : null}
            onMoveUp={moveGroupBy(groupIds, group.group_id, -1)}
            onMoveDown={moveGroupBy(groupIds, group.group_id, 1)}
            onReorder={(ids) => void actions.reorder(ids)}
            projectId={projectId}
          />
        </div>
        {/* The space's sessions, one step in under its name. */}
        <DisclosureContent contentClassName="space-y-px pl-4">
          {rows.map(renderNode)}
          {query.data !== undefined && rows.length === 0 && !query.hasNextPage ? (
            // Aligned to the name's x (px-2), one row tall.
            <p className="text-muted-foreground flex h-8 items-center px-2 text-xs">
              <span className="truncate">{tGroups('empty')}</span>
            </p>
          ) : null}
          {query.hasNextPage && (
            <ShowMoreButton
              loading={query.isFetchingNextPage}
              failed={query.isFetchNextPageError}
              label={t('loadMore')}
              onClick={() => query.fetchNextPage()}
            />
          )}
        </DisclosureContent>
      </Disclosure>
    </div>
  );
}

/**
 * The group header's `⋯`: New group, then Rename, Move up, Move down, then
 * Collapse others, then Delete. Hover-revealed
 * like a section header's; click and Enter/Space stop propagation so opening
 * it never toggles the group.
 */
function SessionGroupMenu({
  projectId,
  group,
  onRename,
  onNewGroup,
  onCollapseOthers,
  onMoveUp,
  onMoveDown,
  onReorder,
}: {
  projectId: string;
  group: ProjectSessionGroup;
  onRename: () => void;
  onNewGroup: () => void;
  /** Null while this is the only group (the item is hidden). */
  onCollapseOthers: (() => void) | null;
  /** The order after Move up / Move down; null at that end (the item is disabled). */
  onMoveUp: string[] | null;
  onMoveDown: string[] | null;
  onReorder: (groupIds: string[]) => void;
}) {
  const tGroups = useTranslations('sidebar.sessionGroups');
  const router = useUiRouter();
  const spaceHref = uiRoutes().sessionSpace?.(projectId, group.group_id) ?? null;
  const pathname = useUiPathname();
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const remove = useDeleteProjectSessionGroup(projectId);
  const afterClose = (fn: () => void) => {
    setMenuOpen(false);
    requestAnimationFrame(fn);
  };

  return (
    // `contents`: the trigger stays a flex item of the header, after the name.
    <span className="contents" onClick={stopAtMenu} onKeyDown={stopAtMenu}>
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            type="button"
            aria-label={`${tGroups('groupOptions')}: ${group.name}`}
            className={cn(
              SESSION_MENU_TRIGGER_CLASS,
              'relative opacity-0',
              'before:absolute before:-inset-1',
              'group-hover/section-header:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100',
            )}
          >
            <DotsThreeIcon className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="right" className="w-44" onCloseAutoFocus={keepFocusForNewGroup}>
          {spaceHref ? (
            <>
              <DropdownMenuItem className="cursor-pointer" onSelect={() => router.push(spaceHref)}>
                <StackIcon />
                {tGroups('openSpace')}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          ) : null}
          <DropdownMenuItem
            className="cursor-pointer"
            onSelect={() => {
              markNewGroupFocus();
              afterClose(onNewGroup);
            }}
          >
            <PlusIcon />
            {tGroups('newGroup')}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem className="cursor-pointer" onSelect={() => afterClose(onRename)}>
            <PencilSimpleIcon />
            {tGroups('rename')}
          </DropdownMenuItem>
          <DropdownMenuItem className="cursor-pointer" disabled={!onMoveUp} onSelect={() => onMoveUp && onReorder(onMoveUp)}>
            <ArrowUpIcon />
            {tGroups('moveUp')}
          </DropdownMenuItem>
          <DropdownMenuItem className="cursor-pointer" disabled={!onMoveDown} onSelect={() => onMoveDown && onReorder(onMoveDown)}>
            <ArrowDownIcon />
            {tGroups('moveDown')}
          </DropdownMenuItem>
          {onCollapseOthers ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem className="cursor-pointer" onSelect={onCollapseOthers}>
                <ArrowsInLineVerticalIcon />
                {tGroups('collapseOthers')}
              </DropdownMenuItem>
            </>
          ) : null}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="cursor-pointer"
            variant="destructive"
            onSelect={() => afterClose(() => setConfirmOpen(true))}
          >
            <TrashIcon />
            {tGroups('delete')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={tGroups('deleteTitle')}
        description={tGroups('deleteDescription', { name: group.name })}
        confirmLabel={tGroups('delete')}
        cancelLabel={tGroups('cancel')}
        confirmVariant="destructive"
        isPending={remove.isPending}
        onConfirm={() =>
          remove.mutate(group.group_id, {
            onSuccess: () => {
              setConfirmOpen(false);
              successToast(tGroups('deleted'));
              // Deleting the space you are looking at leaves its page for the spaces list,
              // not a "This space does not exist" screen.
              if (spaceHref && pathname?.endsWith(spaceHref)) {
                router.push(uiRoutes().sessionSpaces?.(projectId) ?? uiRoutes().project(projectId));
              }
            },
            onError: () => errorToast(tGroups('deleteFailed')),
          })
        }
      />
    </span>
  );
}

/**
 * The rest of the list as a drop target: a session row dropped here leaves
 * its group. Highlights only while a row is over it.
 */
export function UngroupDropArea({
  onDropSession,
  children,
}: {
  onDropSession: (sessionId: string) => void;
  children: ReactNode;
}) {
  const drop = useDropTarget({ onDropSession });
  return (
    <div {...drop.props} className={cn('space-y-px rounded-md', drop.over === 'session' && 'bg-sidebar-row/50')}>
      {children}
    </div>
  );
}
