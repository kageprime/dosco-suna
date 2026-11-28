'use client';

import { ApiError, type ProjectSession, type ProjectSpace } from '@kortix/sdk';
import {
  updateCachedProjectSessions,
  useOpenProjectDm,
  qk,
  useFeatureFlag,
  useProjectConfig,
  useProjectSpaces,
  useSession,
  useSessionChildren,
  useSessionPrompts,
  useProjectSpaceMembers,
  useUpdateProjectSpace,
  useVisibleAgents,
} from '@kortix/sdk/react';
import { isMyKortixAgentName } from '@kortix/shared';
import {
  ArrowDownIcon,
  ArrowSquareOutIcon,
  ArrowsOutSimpleIcon,
  ArrowUpIcon,
  BracketsCurlyIcon,
  CaretDownIcon,
  CopyIcon,
  DotsThreeIcon,
  LinkSimpleIcon,
  MagnifyingGlassIcon,
  MarkdownLogoIcon,
} from '@phosphor-icons/react';
import { clearMatches, findTextRanges, FIND_HIGHLIGHT_CSS, paintMatches } from './thread-find';
import { type ExportMessage, threadAsJson, threadAsMarkdown, threadAsText, threadEntries } from './thread-export';
import { useCopy } from '../../internal/hooks/use-copy';
import { SolidCheckIcon } from '../../internal/icons/solid-check-icon';
import { useQueryClient } from '@tanstack/react-query';
import { type ReactNode, type RefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useTranslations } from '../../i18n';
import { Close } from '../../icons/close';
import { SidebarToggle } from '../../internal/layout/sidebar-toggle';
import { MemoryView } from '../memory/memory-view';
import { UsedMemoryChip } from '../memory/used-memory-chip';
import { useIsPhone } from '../../hooks/use-mobile';
import { ProjectScope } from '../../internal/project-scope';
import { useComposerPrefillStore } from '../../internal/stores/composer-prefill-store';
import { cn } from '../../lib/utils';
import { uiRoutes } from '../../lib/routes';
import { Button } from '../../primitives/button';
import { ConfirmDialog } from '../../primitives/confirm-dialog';
import { EmptyState } from '../../primitives/empty-state';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '../../primitives/resizable';
import { ErrorState } from '../../primitives/error-state';
import Hint from '../../primitives/hint';
import { useOptionalSidebar } from '../../primitives/sidebar';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../primitives/tabs';
import { errorToast, successToast } from '../../primitives/toast';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../../primitives/dropdown-menu';
import { InputGroup, InputGroupAddon, InputGroupInput } from '../../primitives/input-group';
import { participantLabel } from '../../session/participants/session-participants';
import { UiLink as Link, useUiPathname, useUiRouter, useUiSearchParams } from '../../providers/ui-provider';
import { ComposerChatInput, type ComposerOptions } from '../../session/composer/composer-chat-input';
import { ComposerAutoFocusContext } from '../../session/composer/composer-focus-context';
import { FeaturedAgentsContext } from '../../session/composer/agent-selector';
import { ComposerDropZone } from '../../session/composer/composer-drop-zone';
import type { DraftScope } from '../../session/composer/draft/composer-draft';
import { AfterFirstPromptContext } from '../../session/thread/after-first-prompt';
import { SessionThread } from '../../session/thread/session-thread';
import { type TranscriptAuthor, TranscriptRowsContext } from '../../session/thread/transcript-rows';
import { useProjectHomeSend } from '../layout/use-project-home-send';
import { ChannelSetup } from './channel-setup';
import { ChannelsIntro, GeneralChatHead } from './channels-onboarding';
import { CreateChannelDialog } from './create-channel-dialog';
import { channelRunnableAgents, offeredChannelAgents } from './space-agents';
import { SpaceDetailsDialog, type SpaceDetailsTab } from './space-details-dialog';
import { SpaceDetailsPanel } from './space-details-panel';
import { CurrentSpaceContext, parseProfileParam, type Principal, PrincipalHover, ProfileContext, ProfilePanel, profileParam } from './principal-card';
import { SpaceAvatar } from './space-avatar';
import { useSpaceMentionSource } from './space-mention-source';
import { autoOpenThread } from './space-auto-open';
import { useOtherPerson } from './space-people';
import { SpaceMentionContext } from '../../session/composer/menus/space-mentions';
import { spaceDisplayName } from './space-identity';
import { usePersonalSpaceName } from './use-personal-space-name';
import { JoinChannelButton } from './space-members';
import { SpaceRosterButton } from './space-roster';
import { agentLabel, liveReplyCount, replyRole, spaceRoster, threadIsWorking, threadMessageText } from './space-timeline';
import { CHAT_TAB, openTabId } from './space-tab-list';
import { AddTabMenu, type SpaceFile, StoredTabPanel, StoredTabTrigger, useSpaceTabs } from './space-tabs';
import { SpaceTimeline, useSpaceThreads, type SpaceThreads } from './space-timeline-view';
import { SessionDriveFilesScope } from '../../internal/files/session-drive-files';

/** The search and filter keys of the Threads and Links tabs. */
const TAB_FILTER_PARAMS = ['q', 'status', 'by', 'agent', 'active', 'pinned', 'added'] as const;

/** A channel by slug, or the caller's DM with one agent. */
export type SpaceTarget = { kind: 'channel'; slug: string } | { kind: 'dm'; agentName: string };

export interface SpaceViewProps {
  projectId: string;
  target: SpaceTarget;
  /** Runs first on every send. Throw to refuse it: the composer keeps the draft (apps/web checks billing here). */
  beforeSend?: () => Promise<void>;
  /**
   * A folder tab: the host's Drive folder view (apps/web passes its Drive
   * explorer). Absent: a folder tab shows its empty state.
   */
  renderFolder?: (folder: SpaceFolder) => ReactNode;
  /**
   * A file tab: the host's Drive file view (apps/web passes its Drive file
   * viewer). Absent: a file tab shows its empty state.
   */
  renderFile?: (file: SpaceFile) => ReactNode;
  /**
   * `/chat`: the person's own space (their chat with My Kortix). No
   * channels intro; the header and tabs are the same as any space's.
   */
  chat?: boolean;
  /** Replaces the chat composer (a paused agent shows its Resume bar). Absent: the composer. */
  composer?: ReactNode;
  /**
   * Extra buttons at the right of the header (an agent's settings gear). A
   * function gets the details panel's state, so a button can open it.
   */
  headerActions?: ReactNode | ((details: { open: boolean; toggle: () => void }) => ReactNode);
  /** Replaces the details panel's sections, under its name (an agent's settings tabs). */
  detailsBody?: (space: ProjectSpace) => ReactNode;
}

/** What a host's folder view draws for a space. `place` is "#general" or the DM's agent. */
export type { SpaceFile };

export interface SpaceFolder {
  space: ProjectSpace;
  tab: 'files' | 'memory';
  place: string;
  /** A folder tab: the Drive folder path it shows, instead of the space's own folder. */
  path?: string;
  /** A folder tab whose folder is gone: what to show instead (its "Remove tab"). */
  missing?: ReactNode;
}

/** The query key of the open thread: it survives a reload and can be linked. */
const THREAD_PARAM = 'thread';
/** The Profile panel of a person (`person:<user id>`) or an agent (`agent:<name>`). */
const PROFILE_PARAM = 'profile';
/** The details panel: `1` open, `add` open with "Add members" (a space just created). */
const DETAILS_PARAM = 'details';
/** The open tab. Absent on Chat. */
const TAB_PARAM = 'tab';
/** Set by the archive action and by the create dialog's "already exists" link: the archived channel's id. */
const ARCHIVED_PARAM = 'archived';
/** `1` when the viewer may not unarchive that channel (the create dialog's 409 said `can_edit: false`). */
const ARCHIVED_LOCKED_PARAM = 'locked';

/**
 * A channel or DM page under `chat`: the header, the tab row (Chat, then
 * the space's own tabs, which people and Kortix arrange), and the open thread
 * in a panel on the right. Every message starts a new thread.
 */
/** How often an open space re-reads its tabs, which Kortix may change from a thread. */
const SPACE_TABS_POLL_MS = 10_000;

export function SpaceView(props: SpaceViewProps) {
  return (
    <ProjectScope projectId={props.projectId}>
      {/* The project frame has no definite height (the sidebar wrapper is
          `min-h-svh`), so an in-flow page grows it by its content and the
          window scrolls: the composer lands below the fold. Out of flow, the
          view takes exactly the frame's box (the rooms layout does the same). */}
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <div className="absolute inset-0 flex flex-col">
          <SpaceViewBody {...props} />
        </div>
        {props.chat ? null : <ChannelsIntro projectId={props.projectId} />}
      </div>
    </ProjectScope>
  );
}

function SpaceViewBody({ projectId, target, beforeSend, renderFolder, renderFile, composer, headerActions, detailsBody }: SpaceViewProps) {
  const t = useTranslations('spaces.view');
  const router = useUiRouter();
  const pathname = useUiPathname();
  const searchParams = useUiSearchParams();
  const spaces = useProjectSpaces(projectId);
  const chatOn = useFeatureFlag(projectId, 'chat').enabled;
  // Kortix edits a space's tabs from a thread (PUT …/tabs with its session token): read them again while the page is open.
  const queryClient = useQueryClient();
  useEffect(() => {
    const timer = setInterval(() => void queryClient.invalidateQueries({ queryKey: qk.project.spaces(projectId) }), SPACE_TABS_POLL_MS);
    return () => clearInterval(timer);
  }, [projectId, queryClient]);
  const openDm = useOpenProjectDm(projectId);

  const channel =
    target.kind === 'channel'
      ? spaces.data?.find((space) => space.kind === 'channel' && space.slug === target.slug)
      : undefined;
  const listedDm =
    target.kind === 'dm'
      ? spaces.data?.find((space) => space.kind === 'dm' && space.dm_agent_name === target.agentName)
      : undefined;
  const openedDm =
    target.kind === 'dm' && openDm.data?.dm_agent_name === target.agentName ? openDm.data : undefined;
  const space = channel ?? listedDm ?? openedDm;

  // A DM the caller never opened does not exist yet: create it once.
  const dmAgent = target.kind === 'dm' ? target.agentName : null;
  const requestedDm = useRef<string | null>(null);
  const { mutate: openDmMutate } = openDm;
  useEffect(() => {
    if (!dmAgent || !spaces.data || listedDm || requestedDm.current === dmAgent) return;
    requestedDm.current = dmAgent;
    openDmMutate(dmAgent);
  }, [dmAgent, spaces.data, listedDm, openDmMutate]);

  const threads = useSpaceThreads(projectId, space?.space_id);
  // The `@` menu of this space's composers (and its thread's reply box): its people and agents.
  const mentionSource = useSpaceMentionSource(projectId, space);
  const urlThreadId = searchParams.get(THREAD_PARAM);
  // A thread the chat just opened shows at once; the URL follows a moment later
  // (a router round trip). Cleared when the URL names a thread or none.
  const [pendingThreadId, setPendingThreadId] = useState<string | null>(null);
  const [pendingFrom, setPendingFrom] = useState<string | null>(null);
  if (pendingThreadId && urlThreadId !== pendingFrom) {
    setPendingThreadId(null);
    setPendingFrom(null);
  }
  const threadId = pendingThreadId ?? urlThreadId;
  const tab = openTabId(space?.tabs ?? [], searchParams.get(TAB_PARAM));
  // `push` adds a history entry, so the browser's Back walks it: a tab, and
  // opening the thread panel. Filters and switching threads replace the entry.
  const setParams = useCallback(
    (change: (params: URLSearchParams) => void, mode: 'push' | 'replace' = 'replace') => {
      const params = new URLSearchParams(searchParams);
      change(params);
      const query = params.toString();
      router[mode](query ? `${pathname}?${query}` : pathname, { scroll: false });
    },
    [pathname, router, searchParams],
  );
  // The current history entry is the one this view pushed to open the thread:
  // closing goes Back to the entry under it. A reload, a link or a later tab
  // push makes it someone else's entry, so closing replaces it instead.
  const ownThreadEntry = useRef(false);
  useEffect(() => {
    if (!threadId) ownThreadEntry.current = false;
  }, [threadId]);
  const openThread = useCallback(
    (sessionId: string) => {
      if (threadId) return setParams((params) => params.set(THREAD_PARAM, sessionId));
      ownThreadEntry.current = true;
      setParams((params) => {
        params.delete(DETAILS_PARAM);
        params.delete(PROFILE_PARAM);
        params.set(THREAD_PARAM, sessionId);
      }, 'push');
    },
    [setParams, threadId],
  );
  // The thread a message just sent from the chat opened by itself: its reply box does not take the focus.
  const [autoOpenedId, setAutoOpenedId] = useState<string | null>(null);
  const autoOpen = useCallback(
    (sessionId: string) => {
      // The chat's composer stays the place to type: the send disables its editor
      // for a moment (the focus drops to the page) and the panel opens after it.
      // Back to the chat's editor, unless the person is already somewhere else.
      setAutoOpenedId(sessionId);
      setPendingThreadId(sessionId);
      setPendingFrom(urlThreadId);
      openThread(sessionId);
      let tries = 0;
      const restore = () => {
        const now = document.activeElement;
        if (now && now !== document.body) return;
        const editor = document.querySelector<HTMLElement>('[data-space-composer] [contenteditable="true"]');
        if (editor) editor.focus({ preventScroll: true });
        else if (++tries < 15) setTimeout(restore, 100);
      };
      setTimeout(restore, 0);
    },
    [openThread, urlThreadId],
  );
  const closeThread = useCallback(() => {
    if (ownThreadEntry.current) {
      ownThreadEntry.current = false;
      return router.back();
    }
    setParams((params) => params.delete(THREAD_PARAM));
  }, [router, setParams]);
  const setTab = useCallback(
    (next: string) => {
      ownThreadEntry.current = false;
      setParams((params) => {
        // Threads and Links share `q` and `by`: a tab starts unfiltered.
        for (const key of TAB_FILTER_PARAMS) params.delete(key);
        if (next === CHAT_TAB) params.delete(TAB_PARAM);
        else params.set(TAB_PARAM, next);
      }, 'push');
    },
    [setParams],
  );

  // Spaces only: the person's DM with My Kortix is their personal space, another DM a private space named by its agent.
  const personalName = usePersonalSpaceName();
  // A two-person private space reads as the other person, from the viewer's side.
  const otherPerson = useOtherPerson(projectId, space);
  const title = otherPerson
    ? otherPerson.name
    : space
    ? spaceDisplayName(space, personalName)
    : target.kind === 'channel'
      ? target.slug
      : isMyKortixAgentName(target.agentName)
        ? personalName
        : agentLabel(target.agentName);
  // The full settings dialog (make private, leave, archive, member menus): the details panel links it.
  const [details, setDetails] = useState<SpaceDetailsTab | null>(null);
  const [renameOpen, setRenameOpen] = useState(false);
  // The details panel, on the right where a thread opens; one of the two at a time.
  const detailsParam = searchParams.get(DETAILS_PARAM);
  // One right panel at a time: a thread, else a profile, else the details.
  const profile = threadId ? null : parseProfileParam(searchParams.get(PROFILE_PARAM));
  const detailsOpen = !!detailsParam && !threadId && !profile;
  const openProfile = useCallback(
    (principal: Principal) => {
      const value = profileParam(principal);
      if (!value) return;
      ownThreadEntry.current = false;
      setParams((params) => {
        params.delete(THREAD_PARAM);
        params.delete(DETAILS_PARAM);
        params.set(PROFILE_PARAM, value);
      }, 'push');
    },
    [setParams],
  );
  const closeProfile = useCallback(() => setParams((params) => params.delete(PROFILE_PARAM)), [setParams]);
  const openDetails = useCallback(
    (mode: '1' | 'add' | 'people' = '1') => {
      ownThreadEntry.current = false;
      setParams((params) => {
        params.delete(THREAD_PARAM);
        params.delete(PROFILE_PARAM);
        params.set(DETAILS_PARAM, mode);
      }, 'push');
    },
    [setParams],
  );
  const closeDetails = useCallback(() => setParams((params) => params.delete(DETAILS_PARAM)), [setParams]);
  // Esc closes the open right panel, unless a field, a menu or a dialog takes it
  // (the composer's own Esc ×3 stops a turn).
  const closeRightPanel = threadId ? closeThread : profile ? closeProfile : detailsOpen ? closeDetails : null;
  useEffect(() => {
    if (!closeRightPanel) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"]')) return;
      if (document.querySelector('[role="dialog"][data-state="open"], [role="menu"][data-state="open"]')) return;
      closeRightPanel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [closeRightPanel]);
  const header = (
    <SpaceHeader
      projectId={projectId}
      target={target}
      title={title}
      space={space}
      sessions={threads.sessions}
      details={details}
      setDetails={setDetails}
      detailsOpen={detailsOpen}
      onToggleDetails={() => (detailsOpen ? closeDetails() : openDetails())}
      renameOpen={renameOpen}
      setRenameOpen={setRenameOpen}
      onViewAllMembers={() => openDetails('people')}
      actions={
        typeof headerActions === 'function'
          ? headerActions({ open: detailsOpen, toggle: () => (detailsOpen ? closeDetails() : openDetails()) })
          : headerActions
      }
    />
  );

  if (!space) {
    let body = null;
    if (spaces.isError && !spaces.data) {
      body = (
        <ErrorState
          size="sm"
          title={t('loadError')}
          action={
            <Button variant="outline" size="sm" onClick={() => spaces.refetch()}>
              {t('retry')}
            </Button>
          }
        />
      );
    } else if (target.kind === 'dm' && openDm.isError) {
      body = (
        <ErrorState
          size="sm"
          title={t('dmFailed')}
          action={
            <Button
              variant="outline"
              size="sm"
              onClick={() => openDm.mutate(target.agentName)}
              disabled={openDm.isPending}
            >
              {t('retry')}
            </Button>
          }
        />
      );
    } else if (target.kind === 'channel' && spaces.data) {
      const archivedId = searchParams.get(ARCHIVED_PARAM);
      const fallback = spaces.data.find((candidate) => candidate.is_default);
      body = archivedId ? (
        <ArchivedChannel
          projectId={projectId}
          slug={target.slug}
          spaceId={archivedId}
          canEdit={searchParams.get(ARCHIVED_LOCKED_PARAM) !== '1'}
        />
      ) : (
        <EmptyState
          size="sm"
          title={t('notFound')}
          description={t('notFoundHint')}
          action={
            fallback?.slug ? (
              <Button asChild variant="outline" size="sm">
                <Link href={uiRoutes().channel(projectId, fallback.slug)}>
                  {t('openDefault', { name: fallback.slug })}
                </Link>
              </Button>
            ) : null
          }
        />
      );
    }
    // Still loading: the header from the URL, an empty body (navigation shows no skeleton).
    return (
      <div className="bg-background flex min-h-0 flex-1 flex-col overflow-hidden">
        {header}
        <div className="flex min-h-0 flex-1 items-center justify-center px-5 py-8">{body}</div>
      </div>
    );
  }

  const place = space.kind === 'channel' ? `#${space.slug}` : title;
  return (
    // One panel group, always mounted, so opening a thread never remounts the
    // timeline (its scroll and the composer's draft stay). The thread joins
    // the group while one is open; the divider drags, and `autoSaveId` keeps
    // the width per browser. Below `xl` the thread takes the whole width: the
    // timeline panel and the divider hide, and the thread panel's flex-grow
    // fills the row.
    <ProfileContext.Provider value={openProfile}>
    <CurrentSpaceContext.Provider value={space}>
    <SpaceMentionContext.Provider value={mentionSource}>
    <ResizablePanelGroup
      direction="horizontal"
      autoSaveId="kortix:space-thread-split"
      className="bg-background min-h-0 flex-1 overflow-hidden"
    >
      <ResizablePanel
        id="space-timeline"
        order={1}
        minSize={35}
        defaultSize={60}
        className={cn('flex min-w-0 flex-col', (threadId || detailsOpen || profile) && 'max-xl:hidden')}
      >
        <ComposerDropZone className="flex min-h-0 min-w-0 flex-1 flex-col">
          {header}
          <SpaceTabs
            projectId={projectId}
            space={space}
            place={place}
            tab={tab}
            setTab={setTab}
            threads={threads}
            threadId={threadId}
            onOpenThread={openThread}
            onAutoOpenThread={autoOpen}
            onOpenMembers={() => openDetails('add')}
            beforeSend={beforeSend}
            renderFolder={renderFolder}
            renderFile={renderFile}
            composer={composer}
          />
        </ComposerDropZone>
      </ResizablePanel>
      {threadId ? (
        <>
          {/* A 1px hairline with a 12px hit strip (`after:`), so the panels
              stay flush; hover and drag light the app's resize seam. */}
          <ResizableHandle className="w-0 border-l after:absolute after:inset-y-0 after:-left-1.5 after:w-3 max-xl:hidden" />
          <ResizablePanel id="space-thread" order={2} minSize={25} maxSize={65} defaultSize={40} className="flex min-w-0 flex-col">
            <ThreadPanel
              key={threadId}
              projectId={projectId}
              sessionId={threadId}
              context={title}
              thread={threads.sessions.find((session) => session.session_id === threadId)}
              agentFallback={space.dm_agent_name}
              onClose={closeThread}
              // The `chat` flag, not the /chat page: every space's thread shows only messages, and links its full session.
              fullSessionHref={chatOn ? uiRoutes().session(projectId, threadId) : undefined}
              messagesOnly={chatOn}
              quietFocus={threadId === autoOpenedId}
            />
          </ResizablePanel>
        </>
      ) : profile ? (
        <>
          <ResizableHandle className="w-0 border-l after:absolute after:inset-y-0 after:-left-1.5 after:w-3 max-xl:hidden" />
          <ResizablePanel id="space-profile" order={2} minSize={25} maxSize={50} defaultSize={30} className="flex min-w-0 flex-col">
            <ProfilePanel key={profileParam(profile)} projectId={projectId} principal={profile} onClose={closeProfile} />
          </ResizablePanel>
        </>
      ) : detailsOpen ? (
        <>
          <ResizableHandle className="w-0 border-l after:absolute after:inset-y-0 after:-left-1.5 after:w-3 max-xl:hidden" />
          <ResizablePanel id="space-details" order={2} minSize={25} maxSize={50} defaultSize={30} className="flex min-w-0 flex-col">
            <SpaceDetailsPanel
              key={space.space_id}
              projectId={projectId}
              space={space}
              name={title}
              onClose={closeDetails}
              onRename={space.kind === 'channel' ? () => setRenameOpen(true) : undefined}
              onOpenSettings={space.kind === 'channel' ? () => setDetails('about') : undefined}
              addOnOpen={detailsParam === 'add'}
              body={detailsBody?.(space)}
            />
          </ResizablePanel>
        </>
      ) : null}
    </ResizablePanelGroup>
    </SpaceMentionContext.Provider>
    </CurrentSpaceContext.Provider>
    </ProfileContext.Provider>
  );
}

/**
 * The tab row and its panels: Chat (the timeline and the composer), then the
 * space's stored tabs in order (`space-tabs.tsx`), then "+" for a person who
 * may edit them. Only the open tab's panel is mounted.
 */
function SpaceTabs({
  projectId,
  space,
  place,
  tab,
  setTab,
  threads,
  threadId,
  onOpenThread,
  onAutoOpenThread,
  onOpenMembers,
  beforeSend,
  renderFolder,
  renderFile,
  composer,
}: {
  projectId: string;
  space: ProjectSpace;
  /** "#general", or the DM's agent. */
  place: string;
  /** The open tab: `chat` or a stored tab's id. */
  tab: string;
  setTab: (tab: string) => void;
  threads: SpaceThreads;
  threadId: string | null;
  onOpenThread: (sessionId: string) => void;
  /** A message just sent from the chat: open its thread without taking the focus. */
  onAutoOpenThread: (sessionId: string) => void;
  onOpenMembers: () => void;
  beforeSend?: () => Promise<void>;
  renderFolder?: (folder: SpaceFolder) => ReactNode;
  renderFile?: (file: SpaceFile) => ReactNode;
  composer?: ReactNode;
}) {
  const t = useTranslations('spaces.view');
  const state = useSpaceTabs(projectId, space);
  return (
    <Tabs value={tab} onValueChange={setTab} className="min-h-0 flex-1 gap-0">
      <TabsList type="underline" size="sm" className="w-full shrink-0 justify-start gap-4 overflow-x-auto px-5">
        <TabsTrigger value={CHAT_TAB} className="w-fit flex-none">
          {t('tab.chat')}
        </TabsTrigger>
        {state.tabs.map((stored, index) => (
          <StoredTabTrigger key={stored.id} tab={stored} index={index} active={stored.id === tab} state={state} />
        ))}
        {state.canEdit ? (
          // A quiet control, not a tab: muted, 14px, and pulled in to sit after the last tab's label rather than a full tab gap away.
          <AddTabMenu
            projectId={projectId}
            space={space}
            state={state}
            onAdded={setTab}
            triggerClassName="-ml-2 text-muted-foreground hover:text-foreground [&_svg]:size-3.5"
          />
        ) : null}
      </TabsList>
      <TabsContent value={CHAT_TAB} className="flex min-h-0 flex-col">
        {space.is_default ? <GeneralChatHead projectId={projectId} /> : null}
        {space.kind === 'channel' ? <ChannelSetup projectId={projectId} space={space} onOpenMembers={onOpenMembers} /> : null}
        <SpaceTimeline projectId={projectId} space={space} threads={threads} selectedId={threadId} onOpenThread={onOpenThread} />
        {composer ?? (
          <SpaceComposer projectId={projectId} space={space} onOpenThread={onOpenThread} onAutoOpenThread={onAutoOpenThread} beforeSend={beforeSend} />
        )}
      </TabsContent>
      {state.tabs.map((stored) => (
        <TabsContent key={stored.id} value={stored.id} className="flex min-h-0 flex-col overflow-y-auto">
          <StoredTabPanel
            projectId={projectId}
            space={space}
            tab={stored}
            place={place}
            state={state}
            renderFolder={renderFolder}
            renderFile={renderFile}
          />
        </TabsContent>
      ))}
    </Tabs>
  );
}

/**
 * The header row: `# name ⌄` (the channel's details) and its description,
 * then its members and agents; a DM shows its agent. Same
 * title-bar classes as `ProjectPageHeader`, so it clears the desktop window
 * controls the same way.
 */
function SpaceHeader({
  projectId,
  target,
  title,
  space,
  sessions,
  details,
  setDetails,
  detailsOpen,
  onToggleDetails,
  renameOpen,
  setRenameOpen,
  onViewAllMembers,
  actions,
}: {
  projectId: string;
  target: SpaceTarget;
  title: string;
  space: ProjectSpace | undefined;
  sessions: readonly ProjectSession[];
  details: SpaceDetailsTab | null;
  setDetails: (tab: SpaceDetailsTab | null) => void;
  /** The details panel is open: the name's button reads as pressed. */
  detailsOpen: boolean;
  onToggleDetails: () => void;
  renameOpen: boolean;
  setRenameOpen: (open: boolean) => void;
  /** "View all members": the Details panel, at People. */
  onViewAllMembers: () => void;
  actions?: ReactNode;
}) {
  const t = useTranslations('spaces.view');
  const sidebar = useOptionalSidebar();
  const router = useUiRouter();
  const update = useUpdateProjectSpace(projectId);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const channel = target.kind === 'channel' && space ? space : null;
  // The channel's members and its agent list: the same roster for every
  // viewer. The threads a viewer can load only add their thread counts.
  const members = useProjectSpaceMembers(projectId, channel?.space_id);
  const roster = useMemo(() => {
    const found = spaceRoster(sessions, space?.dm_agent_name);
    const threads = new Map(found.people.map((person) => [person.id, person.threads]));
    const people = (members.data?.members ?? []).map((member) => ({
      id: member.user_id,
      name: member.name,
      email: null,
      avatarUrl: member.avatar_url,
      threads: threads.get(member.user_id) ?? 0,
    }));
    return { people, agents: space?.agents ?? [], agentThreads: found.agentThreads };
  }, [sessions, space?.dm_agent_name, space?.agents, members.data]);

  const archive = () => {
    if (!channel) return;
    update.mutate(
      { spaceId: channel.space_id, input: { archived: true } },
      {
        onSuccess: () => {
          setArchiveOpen(false);
          successToast(t('archived'));
          // The page stays on the channel, now archived, with its Unarchive action.
          router.replace(
            `${uiRoutes().channel(projectId, channel.slug ?? title)}?${ARCHIVED_PARAM}=${encodeURIComponent(channel.space_id)}`,
          );
        },
        onError: () => errorToast(t('archiveFailed')),
      },
    );
  };

  return (
    <div
      className="kx-titlebar-row kx-capability-titlebar relative flex shrink-0 items-center gap-2 px-2"
      data-sidebar-collapsed={sidebar?.state === 'collapsed' || undefined}
    >
      <SidebarToggle />
      <div className="kx-titlebar-tabs flex h-12 min-w-0 flex-1 items-center gap-2">
        {/* Slack's channel name: the space's tile, its name and a caret; it opens the details panel on the right. */}
        <h1 className="flex min-w-0 shrink-0">
          <Button
            variant="ghost"
            size="sm"
            className="max-w-72 gap-2 px-1.5"
            aria-label={t('spaceDetails', { name: title })}
            aria-expanded={detailsOpen}
            disabled={!space}
            onClick={onToggleDetails}
          >
            <SpaceAvatar space={space ?? null} personal={target.kind === 'dm' && isMyKortixAgentName(target.agentName)} size="sm" label={title} projectId={projectId} />
            {/* The page title's own size and weight (the titlebar's `text-sm font-medium`), and one trailing glyph: the caret that says it opens Details. Privacy shows in the sidebar row and in Details, not here. */}
            <span className="flex min-w-0 items-center gap-1">
              <span className="truncate text-sm font-medium">{title}</span>
              <CaretDownIcon weight="bold" className="text-muted-foreground size-3 shrink-0" />
            </span>
          </Button>
        </h1>
        {channel?.description ? (
          <p className="text-muted-foreground min-w-0 truncate text-xs" title={channel.description}>
            {channel.description}
          </p>
        ) : null}
      </div>
      {channel && channel.is_member === false && channel.visibility !== 'private' ? <JoinChannelButton projectId={projectId} space={channel} /> : null}
      {actions}
      {channel && (roster.people.length > 0 || roster.agents.length > 0) ? (
        <SpaceRosterButton projectId={projectId} roster={roster} onViewAll={onViewAllMembers} />
      ) : null}
      {channel ? (
        <>
          <SpaceDetailsDialog
            space={channel}
            tab={details}
            onTabChange={setDetails}
            onOpenChange={(open) => setDetails(open ? 'about' : null)}
            onEdit={() => {
              setDetails(null);
              setRenameOpen(true);
            }}
            onArchive={() => {
              setDetails(null);
              setArchiveOpen(true);
            }}
          />
          <CreateChannelDialog projectId={projectId} open={renameOpen} onOpenChange={setRenameOpen} space={channel} />
          <ConfirmDialog
            open={archiveOpen}
            onOpenChange={setArchiveOpen}
            title={t('archiveTitle', { name: title })}
            description={t('archiveDescription')}
            confirmLabel={t('archive')}
            onConfirm={archive}
            isPending={update.isPending}
          />
        </>
      ) : null}
    </div>
  );
}

/**
 * `/c/<slug>` of an archived channel whose id the link carried. Its creator or a
 * project manager (`canEdit`) may bring it back; anyone else reads who can.
 */
function ArchivedChannel({
  projectId,
  slug,
  spaceId,
  canEdit,
}: {
  projectId: string;
  slug: string;
  spaceId: string;
  canEdit: boolean;
}) {
  const t = useTranslations('spaces.view');
  const router = useUiRouter();
  const update = useUpdateProjectSpace(projectId);
  const unarchive = () =>
    update.mutate(
      { spaceId, input: { archived: false } },
      {
        onSuccess: (space) => {
          successToast(t('unarchived'));
          router.replace(uiRoutes().channel(projectId, space.slug ?? slug));
        },
        onError: (err) => errorToast(t(err instanceof ApiError && err.status === 403 ? 'archivedLocked' : 'unarchiveFailed')),
      },
    );
  if (!canEdit) {
    return <EmptyState size="sm" title={t('archivedTitle', { name: slug })} description={t('archivedLocked')} />;
  }
  return (
    <EmptyState
      size="sm"
      title={t('archivedTitle', { name: slug })}
      description={t('archivedHint')}
      action={
        <Button
          variant="outline"
          size="sm"
          onClick={unarchive}
          disabled={update.isPending}
          aria-busy={update.isPending || undefined}
        >
          {t('unarchive')}
        </Button>
      }
    />
  );
}

/**
 * The composer under the timeline. Every send creates a new thread in this
 * space (`useProjectHomeSend` with `space`): the billing gate, uploads and the
 * first prompt work as on project home, and the new thread opens on the right.
 */
function SpaceComposer({
  projectId,
  space,
  onOpenThread,
  onAutoOpenThread,
  beforeSend,
}: {
  projectId: string;
  space: ProjectSpace;
  onOpenThread: (sessionId: string) => void;
  onAutoOpenThread: (sessionId: string) => void;
  beforeSend?: () => Promise<void>;
}) {
  const t = useTranslations('spaces.view');
  const isPhone = useIsPhone();
  // Chat (`chat`): a new message stays in the chat, so several threads start side by side.
  const oneChat = useFeatureFlag(projectId, 'chat').enabled;
  // Chat (`chat`): the new thread opens on the right the moment it exists, and
  // the chat stays where it is, ready for the next message (`autoOpenThread`).
  const spaceSend = useMemo(
    () =>
      oneChat
        ? {
            spaceId: space.space_id,
            // Opened the instant Enter is pressed (the optimistic row has the final id).
            onCreating: (sessionId: string) => autoOpenThread(sessionId, onAutoOpenThread),
            onOpen: () => undefined,
          }
        : { spaceId: space.space_id, onOpen: onOpenThread },
    [space.space_id, onOpenThread, onAutoOpenThread, oneChat],
  );
  const { send, sending } = useProjectHomeSend(projectId, { beforeSend, space: spaceSend });
  const draftScope = useMemo<DraftScope>(() => ({ kind: 'space', spaceId: space.space_id }), [space.space_id]);

  // A prompt handed to project home (`?q=`, "start in chat") lands here, since home opens the default channel.
  const pendingPrefill = useComposerPrefillStore((s) => s.prefillByProject[projectId]);
  const consumePrefill = useComposerPrefillStore((s) => s.consume);
  const [prefill, setPrefill] = useState<Parameters<typeof ComposerChatInput>[0]['prefill']>(null);
  useEffect(() => {
    if (!pendingPrefill) return;
    // Apply what `consume` returns, never the render-time snapshot: the
    // typing buffer may have dropped the entry since this render (another
    // account signed in on the tab), and a dropped entry must not land.
    const taken = consumePrefill(projectId);
    if (!taken) return;
    setPrefill({
      text: taken.text,
      id: Date.now(),
      submit: taken.submit,
      files: taken.files,
      options: taken.options,
      restoreDraft: taken.restoreDraft,
    });
  }, [pendingPrefill, projectId, consumePrefill]);

  const onCommand = useCallback(
    (command: { name: string }, args: string | undefined, options: ComposerOptions) => {
      // The send rejects on failure; the hook already showed the error.
      void Promise.resolve(send(`/${command.name}${args ? ` ${args}` : ''}`, undefined, options)).catch(
        () => undefined,
      );
    },
    [send],
  );

  const agent = space.dm_agent_name;
  // A channel's agents lead its picker; the first one the project still offers starts a new thread.
  const visible = useVisibleAgents({ projectId });
  const projectConfig = useProjectConfig(projectId);
  const projectDefault = projectConfig?.default_agent ?? null;
  // A member with no agent grant still posts here with the channel's agents.
  const runnable = useMemo(() => channelRunnableAgents(space, projectDefault), [space, projectDefault]);
  const offered = useMemo(
    () => [...visible, ...runnable.filter((name) => !visible.some((a) => a.name === name)).map((name) => ({ name }))],
    [visible, runnable],
  );
  const channelAgents = useMemo(() => offeredChannelAgents(space, offered), [space, offered]);
  const channelName = space.slug ?? space.name;
  const featured = useMemo(
    () => (channelAgents.length > 0 ? { label: `#${channelName}`, restLabel: t('allAgents'), names: channelAgents } : null),
    [channelAgents, channelName, t],
  );
  return (
    <div data-space-composer="" className="shrink-0 pt-1 pb-4">
      <FeaturedAgentsContext.Provider value={featured}>
        <ComposerChatInput
          defaultAgentName={channelAgents[0] ?? null}
          channelAgentNames={runnable}
          onSend={send}
          onCommand={onCommand}
          projectId={projectId}
          draftScope={draftScope}
          isSending={sending}
          disabled={sending}
          // The box empties at the keypress; the thread on the right draws the attachments.
          clearOnSend="text-only"
          boundAgentName={agent}
          // A DM is with one agent: its composer never switches to another.
          lockAgent={!!agent}
          // `hint`, not `placeholder`: a placeholder is only the first frame of
          // the rotating tips, and this box must always say where the message goes.
          hint={
            agent ? t('messageAgent', { agent: agentLabel(agent) }) : t('messageChannel', { name: space.slug ?? space.name })
          }
          prefill={prefill}
          // Attach, agent and settings inside the bordered box, down to a 720px
          // window. A phone's toolbar is too narrow beside the model selector, so
          // it keeps the row beneath.
          underbarPlacement={isPhone ? 'below' : 'inline'}
          slashMenuPlacement="above"
          // The timeline's width and side margins, not the centred session column.
          parentClassName="max-w-none px-5"
        />
      </FeaturedAgentsContext.Provider>
    </div>
  );
}

/**
 * "N replies" with a hairline to the right. At 0 (the first answer pending)
 * the hairline is drawn alone at the same place and height, and the count
 * fades in when the answer lands: the answer row never moves.
 */
function RepliesDivider({ count, className }: { count: number; className?: string }) {
  const t = useTranslations('spaces.view');
  return (
    // From the rows' edge (`px-5`, where the avatars start) across the panel: it splits the parent message from its replies.
    <div className={cn('flex px-5', className)}>
      <div className="flex min-w-0 flex-1 items-center gap-3">
      {/* At 0 the text holds "1 reply"'s width, invisible, so the line starts where it will stay. */}
      <span
        aria-hidden={count === 0 || undefined}
        className={cn(
          'text-muted-foreground shrink-0 text-xs tabular-nums transition-opacity duration-(--duration-normal) ease-out motion-reduce:transition-none',
          count === 0 && 'opacity-0',
        )}
      >
        {t('replies', { count: Math.max(count, 1) })}
      </span>
      <div className="bg-border h-px flex-1" />
      </div>
    </div>
  );
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

/**
 * Find in the open thread: a field, the match count, previous and next, and
 * close. Enter goes to the next match, Shift+Enter to the previous, Escape
 * closes. Matches are painted in the transcript (`thread-find.ts`).
 */
function ThreadFindBar({ scope, onClose }: { scope: RefObject<HTMLElement | null>; onClose: () => void }) {
  const t = useTranslations('spaces.view');
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<{ ranges: Range[]; index: number }>({ ranges: [], index: 0 });
  useEffect(() => clearMatches, []);
  const search = (value: string, index = 0) => {
    const ranges = scope.current ? findTextRanges(scope.current, value) : [];
    const at = ranges.length ? ((index % ranges.length) + ranges.length) % ranges.length : 0;
    setFound({ ranges, index: at });
    paintMatches(ranges, at);
  };
  // Previous and next search again: the thread may have grown since.
  const step = (delta: number) => search(query, found.index + delta);
  const count = found.ranges.length;
  return (
    <div className="border-border flex shrink-0 items-center gap-1 border-b px-3 py-2">
      <style>{FIND_HIGHLIGHT_CSS}</style>
      <InputGroup className="h-8 flex-1">
        <InputGroupAddon>
          <MagnifyingGlassIcon />
        </InputGroupAddon>
        <InputGroupInput
          autoFocus
          value={query}
          placeholder={t('findPlaceholder')}
          aria-label={t('findInThread')}
          onChange={(event) => {
            setQuery(event.target.value);
            search(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              step(event.shiftKey ? -1 : 1);
            } else if (event.key === 'Escape') {
              event.preventDefault();
              onClose();
            }
          }}
        />
        {query ? (
          <InputGroupAddon align="inline-end" className="text-muted-foreground text-xs tabular-nums">
            {count ? t('findCount', { index: found.index + 1, count }) : t('findNone')}
          </InputGroupAddon>
        ) : null}
      </InputGroup>
      <Hint label={t('findPrevious')} side="bottom">
        <Button variant="ghost" size="icon-base" aria-label={t('findPrevious')} disabled={count === 0} onClick={() => step(-1)}>
          <ArrowUpIcon className="size-4" />
        </Button>
      </Hint>
      <Hint label={t('findNext')} side="bottom">
        <Button variant="ghost" size="icon-base" aria-label={t('findNext')} disabled={count === 0} onClick={() => step(1)}>
          <ArrowDownIcon className="size-4" />
        </Button>
      </Hint>
      <Hint label={t('closeFind')} side="bottom">
        <Button variant="ghost" size="icon-base" aria-label={t('closeFind')} onClick={onClose}>
          <Close />
        </Button>
      </Hint>
    </div>
  );
}

/**
 * The open thread's More menu: open its full session (here, or in a new
 * window), and copy it as text, Markdown or JSON (`thread-export.ts`), or its link.
 */
function ThreadMoreMenu({
  sessionId,
  fullHref,
  title,
  messages,
  names,
}: {
  sessionId: string;
  fullHref: string | undefined;
  title: string;
  messages: readonly ExportMessage[];
  names: { person: string; agent: string };
}) {
  const t = useTranslations('spaces.view');
  const { copy } = useCopy({ toast: false });
  const copied = async (value: string) => {
    await copy(value);
    successToast(t('threadCopied'));
  };
  const entries = () => threadEntries(messages, names);
  const threadUrl = () => {
    const url = new URL(window.location.href);
    url.search = '';
    url.searchParams.set('thread', sessionId);
    return url.toString();
  };
  const newWindowUrl = () => (fullHref ? new URL(fullHref, window.location.origin).toString() : threadUrl());
  return (
    <DropdownMenu>
      <Hint label={t('moreActions')} side="bottom">
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-base" aria-label={t('moreActions')} className="text-muted-foreground hover:text-foreground">
            <DotsThreeIcon weight="bold" className="size-4" />
          </Button>
        </DropdownMenuTrigger>
      </Hint>
      <DropdownMenuContent align="end" className="min-w-52">
        {fullHref ? (
          <DropdownMenuItem asChild>
            <Link href={fullHref}>
              <ArrowsOutSimpleIcon />
              {t('openFullSession')}
            </Link>
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem onSelect={() => window.open(newWindowUrl(), '_blank', 'noopener')}>
          <ArrowSquareOutIcon />
          {t('openInNewWindow')}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void copied(threadAsText(entries()))}>
          <CopyIcon />
          {t('copyThreadText')}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void copied(threadAsMarkdown(entries(), title))}>
          <MarkdownLogoIcon />
          {t('copyMarkdown')}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void copied(threadAsJson(entries(), { sessionId, title }))}>
          <BracketsCurlyIcon />
          {t('copyJson')}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void copied(threadUrl())}>
          <LinkSimpleIcon />
          {t('copyLink')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Copies the open thread's link (the space's URL with `?thread=`), the timeline toolbar's same link. */
function ThreadLinkButton({ sessionId }: { sessionId: string }) {
  const t = useTranslations('spaces.view');
  const { copied, copy } = useCopy({ toast: false });
  const label = copied ? t('linkCopied') : t('copyLink');
  return (
    <Hint label={label} side="bottom">
      <Button
        variant="ghost"
        size="icon-base"
        aria-label={label}
        className="text-muted-foreground hover:text-foreground"
        onClick={() => {
          const url = new URL(window.location.href);
          url.search = '';
          url.searchParams.set('thread', sessionId);
          void copy(url.toString());
        }}
      >
        {copied ? <SolidCheckIcon className="size-4" /> : <LinkSimpleIcon className="size-4" />}
      </Button>
    </Hint>
  );
}

/**
 * The open thread, beside the timeline: its header, then the session's
 * transcript drawn as message rows (`TranscriptRowsContext`) with the reply
 * composer under it. Sending continues the same session.
 */
function ThreadPanel({
  projectId,
  sessionId,
  context,
  thread,
  agentFallback,
  onClose,
  fullSessionHref,
  messagesOnly = false,
  quietFocus = false,
}: {
  projectId: string;
  sessionId: string;
  context: string;
  /** The thread's list row, when loaded: its reply count and its author. */
  thread: ProjectSession | undefined;
  agentFallback: string | null;
  onClose: () => void;
  /** One chat: the thread's full session, for a person who wants every step. A talk-only thread's worker replaces it. */
  fullSessionHref?: string;
  /** Chat (`chat`): the thread shows only messages; its work stays in the full session. */
  messagesOnly?: boolean;
  /** Opened by a message just sent from the chat: its reply box does not take the focus. */
  quietFocus?: boolean;
}) {
  const t = useTranslations('spaces.view');
  const session = useSession(projectId, sessionId);
  useLiveThreadRow(projectId, sessionId, session);
  // Find in thread: a bar under the header, opened by its button or Cmd/Ctrl+F.
  const [findOpen, setFindOpen] = useState(false);
  const threadBodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        setFindOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const fullHref = useFullSessionHref(projectId, sessionId, thread, fullSessionHref);
  // Null from an older API that does not count replies.
  const replyCount = thread?.reply_count ?? null;
  const dividerOnTop = Boolean(replyCount) && session.hasOlder;
  const answered = session.messages.some((message) => message.info.role === 'assistant');
  // A turn has finished: the thread's "Used memory" record can be read.
  const turnDone = !session.isBusy && answered;
  // The first answer is on its way (or landed a frame before its count):
  // the divider is drawn without a count, so the answer does not push it in.
  const answerPending = replyCount === 0 && (session.isBusy || answered || (!!thread && threadIsWorking(thread)));
  // Stable across stream frames: every memoized turn reads this context.
  // "Used memory" sits under the first prompt, or heads the panel with the divider.
  const afterFirstPrompt = useMemo(
    () =>
      dividerOnTop ? null : (
        <>
          {replyCount || answerPending ? <RepliesDivider count={replyCount ?? 0} className="py-2" /> : null}
          {messagesOnly ? null : (
            <UsedMemoryChip projectId={projectId} sessionId={sessionId} ready={turnDone} className="px-5" />
          )}
        </>
      ),
    [replyCount, answerPending, dividerOnTop, projectId, sessionId, turnDone, messagesOnly],
  );
  const agentName = session.agentName ?? thread?.agent_name ?? agentFallback;
  const rows = useMemo(
    () => ({
      agent: agentName ? agentLabel(agentName) : t('agentFallback'),
      agentSlug: agentName ?? undefined,
      owner: thread
        ? { id: thread.created_by ?? null, name: thread.owner_name ?? null, email: thread.owner_email ?? null, avatarUrl: thread.owner_avatar_url ?? null }
        : null,
      // Every avatar and name in the thread opens the person's or agent's card.
      author: (who: TranscriptAuthor, node: ReactNode, part: 'avatar' | 'name') => (
        <PrincipalHover projectId={projectId} principal={who} focusable={part === 'name'}>
          {node}
        </PrincipalHover>
      ),
      unknownAuthor: t('authorFallback'),
      // The composer's computer notices say "thread", never "session".
      notices: {
        unreachable: t('notice.unreachable'),
        unreachableMidTurn: t('notice.unreachableMidTurn'),
        stalled: t('notice.stalled'),
        starting: t('notice.starting'),
        idle: t('notice.idle'),
        waking: t('notice.waking'),
      },
      labels: {
        restart: t('boot.restart'),
      },
      messagesOnly,
      // A talk-only thread: "Show work" opens its worker sessions.
      front: thread?.metadata?.kortix_front === true,
    }),
    [agentName, thread, t, messagesOnly, projectId],
  );
  return (
    <aside aria-label={t('threadTitle')} data-thread-panel="" className="bg-background flex min-h-0 w-full flex-1 flex-col">
      {/* A link to a file in the thread folder (`/drives/…`, a worker's result) opens through this thread's drive mounts. */}
      <SessionDriveFilesScope projectId={projectId} sessionId={sessionId} />
      <div className="kx-titlebar-row relative flex shrink-0 items-center gap-2 border-b px-2">
        <div className="kx-titlebar-tabs flex h-12 min-w-0 flex-1 items-center px-3">
          <div className="flex min-w-0 items-baseline gap-2">
            <h2 className="text-base font-semibold">{t('threadTitle')}</h2>
            {/* The space, quietly: it closes the thread back to the space's chat. */}
            <button
              type="button"
              onClick={onClose}
              className="text-muted-foreground hover:text-foreground focus-visible:ring-ring min-w-0 truncate rounded-sm text-xs outline-none hover:underline focus-visible:ring-2"
            >
              {context}
            </button>
          </div>
        </div>
        {/* The thread's tools, the close last: find, More, copy its link. */}
        <div className="flex items-center gap-px">
          <Hint label={<span>{t('findInThread')} · {isMac ? '⌘' : 'Ctrl'}F</span>} side="bottom">
            <Button
              variant="ghost"
              size="icon-base"
              aria-label={t('findInThread')}
              aria-pressed={findOpen}
              onClick={() => setFindOpen((open) => !open)}
              className={cn('text-muted-foreground hover:text-foreground', findOpen && 'bg-hover text-foreground')}
            >
              <MagnifyingGlassIcon className="size-4" />
            </Button>
          </Hint>
          <ThreadMoreMenu
            sessionId={sessionId}
            fullHref={fullHref}
            title={thread ? threadMessageText(thread).split('\n')[0]!.slice(0, 80) || context : context}
            messages={session.messages}
            names={{
              person: participantLabel({ name: thread?.owner_name ?? null, email: thread?.owner_email ?? null }) || t('authorFallback'),
              agent: rows.agent,
            }}
          />
          <ThreadLinkButton sessionId={sessionId} />
        <Hint label={t('closeThread')} side="bottom">
          <Button variant="ghost" size="icon-base" aria-label={t('closeThread')} onClick={onClose}>
            <Close />
          </Button>
        </Hint>
        </div>
      </div>
      {/* The parent message, then "N replies", then the replies. While older
          history is not loaded, the first turn on screen is not the parent
          message, so the divider heads the panel instead. */}
      {replyCount && dividerOnTop ? (
        <div className="shrink-0 pt-3">
          <RepliesDivider count={replyCount} />
          {messagesOnly ? null : (
            <UsedMemoryChip projectId={projectId} sessionId={sessionId} ready={turnDone} className="px-5" />
          )}
        </div>
      ) : null}
      {findOpen ? <ThreadFindBar scope={threadBodyRef} onClose={() => setFindOpen(false)} /> : null}
      <div ref={threadBodyRef} className="flex min-h-0 flex-1 flex-col">
        <TranscriptRowsContext.Provider value={rows}>
          <AfterFirstPromptContext.Provider value={afterFirstPrompt}>
            <ComposerAutoFocusContext.Provider value={!quietFocus}>
              <SessionThread session={session} hideHeader composerPlaceholder={t('replyPlaceholder')} className="min-h-0 flex-1" />
            </ComposerAutoFocusContext.Provider>
          </AfterFirstPromptContext.Provider>
        </TranscriptRowsContext.Provider>
      </div>
    </aside>
  );
}

/**
 * Where "Open full session" goes. A talk-only thread (`chat_front`, server
 * metadata `kortix_front`) only talks: its work runs in its one child, the
 * worker, so the link opens the worker once it exists. Every other thread
 * opens itself.
 */
function useFullSessionHref(
  projectId: string,
  sessionId: string,
  thread: ProjectSession | undefined,
  fallback: string | undefined,
): string | undefined {
  const front = !!fallback && thread?.metadata?.kortix_front === true;
  // Polls every 5 s until the front starts its worker, then stops.
  const [polling, setPolling] = useState(true);
  const children = useSessionChildren(projectId, sessionId, {
    enabled: front,
    limit: 1,
    refetchInterval: polling ? 5_000 : undefined,
  });
  const workerId = children.sessions[0]?.session_id ?? null;
  if (polling && workerId) setPolling(false);
  if (!front || !workerId) return fallback;
  return uiRoutes().session(projectId, workerId);
}

/**
 * The open thread's live stream, written into its row in the space's cached
 * list: the timeline's "N replies", "Last reply" and "is working" change the
 * frame the panel does, not at the list's next poll (5 s working, 15 s idle).
 * The count needs the whole transcript (`hasOlder` false); with older history
 * unloaded only the working state is written. The poll still reconciles.
 */
function useLiveThreadRow(projectId: string, sessionId: string, session: ReturnType<typeof useSession>) {
  const queryClient = useQueryClient();
  const busy = session.isBusy;
  // A reply counts from Enter: the prompt inbox holds it (optimistically)
  // until the transcript has its message. The same query the panel's chat reads.
  const inbox = useSessionPrompts(projectId, sessionId);
  const ids = new Set(session.messages.map((message) => message.info.id));
  const waiting = inbox.prompts.filter(
    (prompt) =>
      prompt.state !== 'failed' && !ids.has(prompt.message_id) && !(prompt.wire_message_id && ids.has(prompt.wire_message_id)),
  ).length;
  const roles = [
    ...session.messages.map((message) => replyRole(message.info.role, message.parts)),
    ...Array.from({ length: waiting }, () => 'user'),
  ];
  const replies = session.hasOlder || roles.length === 0 ? null : liveReplyCount(roles);
  // The stream has an answer: the computer is up, so a booting status is stale.
  const answered = roles.includes('assistant');
  // Sent, not yet running: the thread is working from Enter.
  const working = busy || waiting > 0;
  // Before the runtime is up the stream knows nothing: the list's own state stands.
  const live = !!session.runtimeSessionId;
  useEffect(() => {
    if (!live) return;
    updateCachedProjectSessions(queryClient, projectId, (rows) => {
      const index = rows.findIndex((row) => row.session_id === sessionId);
      const row = rows[index];
      if (!row) return rows;
      const grew = replies !== null && replies > (row.reply_count ?? 0);
      const booting = row.status === 'provisioning' || row.status === 'queued' || row.status === 'branching';
      const settle = (working || answered) && booting;
      if (!grew && !settle && (row.working?.state === 'working') === working) return rows;
      const now = new Date().toISOString();
      const next = rows.slice();
      next[index] = {
        ...row,
        ...(grew ? { reply_count: replies, updated_at: now } : {}),
        // `threadIsWorking` reads the status too: a thread the stream answers is up.
        ...(settle ? { status: 'running' as const } : {}),
        working: {
          state: working ? 'working' : 'idle',
          since: working ? (row.working?.since ?? now) : null,
          turn_token: row.working?.turn_token ?? null,
          pending_delivery: false,
        },
      };
      return next;
    });
  }, [queryClient, projectId, sessionId, live, working, replies, answered]);
}
