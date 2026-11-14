/**
 * ProjectLeftDrawer — the project sidebar. It opens from every project page
 * (the hamburger, or a rightward swipe) as the ChatGPT-style peek card: the
 * sidebar takes 82% of the window (max 360pt, `projectDrawerWidth`) and the
 * page slides right as a rounded card (`DrawerPeekCard`, ProjectScreen); a
 * tap or a swipe on the visible strip closes it.
 *
 * Top to bottom:
 * - Switcher row (COR-124/COR-157, Task 4): the account avatar overlapped
 *   by the project tile, the project name, and "in <account>" below it. Tap calls
 *   `onOpenSwitcher`: ProjectScreen opens `ProjectSwitcherSheet` (mounted
 *   there once, beside the other project sheets) over the drawer — one
 *   project/account switcher, not a navigation.
 *   The drawer's own gear button is gone: the project Settings page is
 *   reached from Settings (drawer avatar) → project row.
 * - Nav rows, the first rows of the scrolling list (they scroll away with
 *   it, so a new pill never shrinks the list): Search (→ Sessions, its search field auto-focused), Files
 *   (→ /projects/[id]/files), Review (→ the Review page, a trailing count
 *   pill while items wait), and Apps (→ the Apps page, the project's
 *   deployed apps). Notifications is the bell at the top right of project
 *   home (`NotificationsButton`), not a row here (Jay, 2026-10-16).
 *   Connectors moved to project Settings → Customize
 *   (KRTX-249): a "Customize in the web app" hand-off sheet, not a drawer row.
 * - "Pinned" first (KRTX-2418): the sessions the viewer pinned, any starter
 *   and any depth, open by default.
 *   A pinned session is not repeated below, also while Pinned is collapsed.
 * - Three sections of top-level sessions, by who started the run (KRTX-639):
 *   "Sessions" (yours, open), "Shared" (other members', collapsed) and
 *   "Automated" (triggers, channels, API keys; collapsed). A section with no
 *   row to show has no header and no "Show more", whatever its cursor; a
 *   section's "Show more" reads pages until one adds a row it shows
 *   (`fetchUntilShownRowsGrow`). No section renders while the viewer's own
 *   list or the pinned list still loads. A page can be empty and still carry
 *   a cursor (KRTX-1727): each list reads past such pages on its own, and with
 *   no row in any list and an own next page the drawer offers "Show more",
 *   never "No sessions yet". A side section whose loaded rows all show
 *   elsewhere reads its next pages once on its own.
 *   Each is its own paged query (`parent=root`), newest activity first
 *   (status mark · title; the session on screen is highlighted). A parent
 *   shows its child count and a caret, collapsed by default: a tap loads its
 *   children 20 at a time ("Show more"). The open session's parent starts
 *   open, and a child never renders without its parent
 *   (`buildDrawerItems`, lib/session/session-tree.ts). Shared and Automated
 *   rows name their starter under the title.
 *   A row whose root runtime session has sub-sessions (`directSubsessions`)
 *   shows their count after its title and ALWAYS lists them under its row,
 *   joined by a connector (`SubsessionTree`) — every such row, not only the
 *   session on screen. A sub-session row shows that sub-session: in place
 *   when its parent is the open thread, else it opens the parent first.
 *   Then Previous
 *   chats. Pages load as the list nears its end; a pull refreshes it.
 *   Long press opens `SessionActionsSheet` (Rename, Share, Pin, Archive,
 *   Restart sandbox, Stop, Delete) over the drawer — the drawer stays open, the same
 *   exception the switcher row makes.
 * - Pinned bottom bar (`PinnedBar`, a fade of the drawer surface): the user's
 *   profile photo in its plan's gradient ring (`PlanRingAvatar`; → the Account
 *   page at /projects/[id]/account) · New session (large pill). On iOS 26 both
 *   sit on native Liquid Glass (`GlassButtons`: the button inside the glass);
 *   elsewhere the avatar is bare and New session the primary pill.
 *
 * Every action closes the drawer first, except the switcher row: it opens a
 * sheet over the drawer, and only a pick inside that sheet closes the drawer.
 * The navigation runs one frame after the close (`closeThen`): the close
 * then animates on the UI thread while the new page renders, instead of
 * waiting for that render. Search, Files, Artifacts and Account go through
 * `onNavigateRoute`, Review and Apps through `onOpenPage` (ProjectScreen):
 * the destination swaps in under the closing drawer, with no push slide
 * (`DRAWER_SWAP_PARAM`, lib/session/project-stack): a push over home, or a replace of the
 * screen that covers home, so the project stack stays one screen deep
 * (lib/session/project-stack). New session returns to project home and pops a
 * covering screen. A navigation guard ignores a second tap while the drawer
 * closes, so a double tap never navigates twice.
 *
 * Layout rules: apps/mobile/design.md → Project sidebar.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, RefreshControl, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useIsFocused } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColorScheme } from 'nativewind';
import { LinearGradient } from 'expo-linear-gradient';
import {
  CardsThreeIcon,
  FoldersIcon,
  CaretDownIcon,
  CaretRightIcon,
  MagnifyingGlassIcon,
  SquaresFourIcon,
  PlusIcon,
  SealCheckIcon,
} from '@/lib/icons';
import { useDrawerProgress } from 'react-native-drawer-layout';
import Animated, {
  Extrapolation,
  interpolate,
  useAnimatedReaction,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useSharedValue,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { KortixLoader } from '@/components/kortix/kortix-loader';
import { PixelDeadFlower } from '@/components/kortix/PixelDeadFlower';
import { DrawerSessionNode, NESTED_SESSION_INDENT, useSessionStarterOf } from './DrawerSessionRows';
import { SubsessionTreeMemory } from '@/components/session/SessionSubsessionTree';
import { CountBadge } from '@/components/kortix/count-badge';
import { GlassButtons, LIQUID_GLASS_AVAILABLE } from '@/components/kortix/liquid-glass';
import { PinnedBar, usePinnedBarInset } from '@/components/kortix/pinned-bar';
import { NavPill, SwitcherRow } from './DrawerNavRows';
import { SessionChildren, type SessionChildrenProps } from '@/components/session/SessionTreeParts';
import { PlanRingAvatar } from '@/components/settings/PlanRingAvatar';
import { useActivePlanName } from '@/hooks/useActivePlanName';
import { useProfileEditor } from '@/hooks/useProfileEditor';
import { haptics } from '@/lib/haptics';
import { useRefetchOnOpen } from '@/components/session/use-refetch-on-open';
import { useCans, useFeatureFlag, useProjectApps } from '@kortix/sdk/react';
import { useProject, useProjectSessionsPaged } from '@/lib/projects/hooks';
import { NAV_ACTIONS, REVIEW_ACCESS, appsRowVisible, artifactsRowVisible, navAccessAllowed } from '@/lib/session/nav-access';
import { fetchUntilShownRowsGrow, sessionListState, shouldLoadMoreSessions } from '@/lib/session/session-pages';
import type { ProjectSession } from '@/lib/projects/projects-client';
import {
  PROJECT_ACCOUNT_ROUTE,
  PROJECT_ARTIFACTS_ROUTE,
  PROJECT_FILES_ROUTE,
  PROJECT_SESSIONS_ROUTE,
  type DrawerPageId,
  type ProjectDrawerRoute,
} from '@/lib/session/project-stack';
import {
  buildDrawerItems,
  isParentExpanded,
  rootRowsOnly,
  sessionsInView,
  uniqueSessions,
  type DrawerItem,
  type DrawerSectionId,
} from '@/lib/session/session-tree';
import { parentKey, sectionKey, useSessionTreeStore } from '@/stores/session-tree-store';
import { useAuthContext } from '@/contexts';
import type { SessionNeedsYou } from '@/lib/session/needs-you';
import { BUTTON_LABEL_MAX_FONT_SCALE } from '@/lib/ui/font-scale';
import { THEME, withAlpha } from '@/lib/utils/theme';

/** `Button size="lg"` height: the New session pill and the avatar match it. */
const BAR_CONTROL_HEIGHT = 44;
/** The drawer's bottom bar sits this far above the home indicator (the shared bar's 16, plus 8). */
const DRAWER_BAR_BOTTOM_GAP = 24;
/** Extra room between the list's last row and the bottom bar. */
const DRAWER_LIST_END_EXTRA = 16;
/**
 * The avatar inside its 44pt glass circle on iOS 26: a 4pt rim of glass shows
 * around it. Without glass the avatar is the whole 44pt control.
 */
const AVATAR_ON_GLASS = 36;
/**
 * Every row sits in a 4pt column (`px-1`). Rows pad 16pt (`px-4`), so icons,
 * status marks and section labels start on the 20pt line.
 */
const ROW_COLUMN = 'px-1';
/**
 * "Show more" under a section: the ghost button's 12pt padding puts its label
 * on the row titles' edge (4 + 16 + 20pt slot + 12pt gap = 52 = 40 + 12).
 */
const SHOW_MORE_INSET = 'pl-10';
/**
 * Height of the fade at the top of the session list. It also is the scroll
 * distance over which the fade appears: invisible at rest, so the first row is
 * never dimmed, fully shown once a row has scrolled under the switcher row.
 */
const LIST_TOP_FADE_HEIGHT = 24;
/** The open refetch waits out the drawer's 420ms slide (`DRAWER_OPEN`). */
const DRAWER_REFETCH_DELAY_MS = 450;
/** Drawer progress at or below this counts as closed (fully off screen). */
const DRAWER_CLOSED_PROGRESS = 0.01;

/**
 * The empty session list's art. The petal loop runs only while the drawer is
 * open: the drawer content stays mounted while closed. The visibility state
 * lives here, so opening the drawer re-renders this node only.
 */
function DrawerEmptyFlower({ color }: { color: string }) {
  const progress = useDrawerProgress();
  const [visible, setVisible] = useState(false);
  useAnimatedReaction(
    () => progress.value > DRAWER_CLOSED_PROGRESS,
    (next, prev) => {
      if (next !== prev) scheduleOnRN(setVisible, next);
    }
  );
  return <PixelDeadFlower color={color} animate={visible} />;
}

/**
 * The drawer's `open`, for the children blocks' loaders. A context, not a
 * `renderItem` dependency: a drawer open or close then re-renders those
 * blocks only, not every list cell.
 */
const DrawerOpenContext = React.createContext(false);

function DrawerSessionChildren(props: Omit<SessionChildrenProps, 'showLoader'>) {
  const open = React.useContext(DrawerOpenContext);
  return <SessionChildren {...props} showLoader={open} />;
}

/** A section's "Show more": "Loading…" and disabled while its page loads. */
function ShowMoreRow({ loading = false, onPress }: { loading?: boolean; onPress: () => void }) {
  return (
    <View className={`${ROW_COLUMN} ${SHOW_MORE_INSET} items-start`}>
      <Button
        variant="ghost"
        size="sm"
        disabled={loading}
        onPress={() => {
          haptics.tap();
          onPress();
        }}>
        <Text>{loading ? 'Loading…' : 'Show more'}</Text>
      </Button>
    </View>
  );
}

// ─── ProjectLeftDrawer ───────────────────────────────────────────────────────

export interface ProjectLeftDrawerProps {
  projectId: string;
  /**
   * The project session on screen (an open thread or a connecting session).
   * Its row is highlighted; tapping it only closes the drawer (ProjectScreen).
   */
  activeProjectSessionId?: string | null;
  /**
   * The runtime session id the open thread shows (tab store `activeSessionId`): the
   * root of `activeProjectSessionId`, or one of its sub-sessions. Null while
   * no thread is on screen. Picks which sub-session row is highlighted.
   */
  activeRuntimeSessionId?: string | null;
  /** The open session's parent (`sessionParentId`): that parent opens by default (KRTX-639). */
  activeParentSessionId?: string | null;
  /** Items that wait for the user — the Review row's trailing count pill. */
  reviewNeedsYouCount?: number;
  /**
   * Session id → what it waits on (`needsYouBySession` over the review inbox).
   * Those sessions leave the list for a "Needs you" group at its top, in the
   * same scroll (no count; Jay, 2026-09-27).
   */
  needsYouBySession?: ReadonlyMap<string, SessionNeedsYou>;
  /** New session: open project home, whose composer starts the session. */
  onNewSession: () => void;
  onOpenProjectSession: (session: ProjectSession) => void;
  /**
   * A sub-session row: show that runtime session — in place when its parent
   * is the open thread, else after opening the parent (ProjectScreen,
   * `drawerThreadMove`).
   */
  onOpenSubsession: (parent: ProjectSession, childId: string) => void;
  /** Sessions, Files, Artifacts, or Account: push over home, or replace the covering screen. */
  onNavigateRoute: (route: ProjectDrawerRoute, routeParams?: Record<string, string>) => void;
  /** Review or Apps: a tab-store page, shown in the view route. */
  onOpenPage: (pageId: DrawerPageId) => void;
  /**
   * Long press on a session row: opens `SessionActionsSheet` over the drawer
   * (COR-140 Task 5) — the drawer does not close for it, the same exception
   * the switcher row makes.
   */
  onSessionActions: (session: ProjectSession) => void;
  /**
   * The switcher row: open `ProjectSwitcherSheet` over the drawer. The drawer
   * stays open behind it; only a pick in the sheet closes the drawer.
   */
  onOpenSwitcher: () => void;
  /** Close the drawer. Every action calls this before it navigates. */
  onClose: () => void;
  /**
   * The drawer is open (false as soon as it starts to close). Its list
   * loaders draw only while it is open: a row tap closes the drawer over the
   * connecting session's loader, and one loader shows at a time (KRTX-244).
   */
  open: boolean;
}

const drawerItemKey = (item: DrawerItem) =>
  item.kind === 'header'
    ? `header:${item.section}`
    : item.kind === 'more'
      ? `more:${item.section}`
      : `${item.kind}:${item.session.session_id}`;
/** The sections with their own Show more. */
type SideSection = 'pinned' | 'shared' | 'automated';
/** Pinned, Automated and Shared page size: small, they load only to show a header or a first screen. */
const SIDE_SECTION_PAGE_SIZE = 20;
/** Shared empty map: a fresh one per render would re-derive the lists. */
const EMPTY_NEEDS_YOU: ReadonlyMap<string, SessionNeedsYou> = new Map();

/**
 * Memoized: ProjectScreen re-renders it on every poll and sheet change, and
 * its props are stable.
 */
export const ProjectLeftDrawer = React.memo(function ProjectLeftDrawer({
  projectId,
  activeProjectSessionId = null,
  activeRuntimeSessionId = null,
  activeParentSessionId = null,
  reviewNeedsYouCount = 0,
  needsYouBySession = EMPTY_NEEDS_YOU,
  onNewSession,
  onOpenProjectSession,
  onOpenSubsession,
  onNavigateRoute,
  onOpenPage,
  onSessionActions,
  onOpenSwitcher,
  onClose,
  open,
}: ProjectLeftDrawerProps): React.ReactElement {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const insets = useSafeAreaInsets();
  const { t } = useTranslation();

  // The drawer stays mounted while a root screen (Billing, a settings page)
  // covers the project.
  // Poll for provisioning rows only while the project screen is focused.
  const isFocused = useIsFocused();

  // Review and Apps show only to a caller who can act on them (web's rule):
  // nothing renders before the verdict lands.
  const navCans = useCans({ projectId }, NAV_ACTIONS);
  const appsQuery = useProjectApps(projectId);
  const showReview = navAccessAllowed(navCans, REVIEW_ACCESS);
  const showApps = appsRowVisible(navCans, appsQuery.data?.length);
  // Artifacts: the platform stores a Drive, and the caller may read artifacts.
  const artifactsFlag = useFeatureFlag(projectId, 'artifacts');
  const showArtifacts = artifactsRowVisible(navCans, artifactsFlag.enabled);

  // The switcher row's workspace tile and name.
  const { data: project } = useProject(projectId);
  const openSwitcher = useCallback(() => {
    haptics.tap();
    onOpenSwitcher();
  }, [onOpenSwitcher]);
  // KRTX-639: three independent paged queries of top-level sessions, by who
  // started the run. Children load per parent, on expand (`SessionChildren`).
  const viewerId = useAuthContext().user?.id ?? null;
  const starterOf = useSessionStarterOf(viewerId);
  const choices = useSessionTreeStore((state) => state.choices);
  const setChoice = useSessionTreeStore((state) => state.setChoice);
  const sectionOpen = (id: DrawerSectionId) =>
    choices[sectionKey(projectId, id)] ?? (id === 'sessions' || id === 'pinned');
  const sharedOpen = sectionOpen('shared');
  const automatedOpen = sectionOpen('automated');
  // Polls only while the drawer is open: its content stays mounted while
  // closed, every poll result re-rendered it (~2 renders per 3 s), and the
  // open refetch below already shows a fresh list.
  const mine = useProjectSessionsPaged(projectId, { poll: isFocused && open, parent: 'root', startedBy: 'me' });
  // KRTX-2418: the viewer's pinned sessions, any starter and any depth (a pin
  // is the viewer's choice), above the three sections.
  const pinned = useProjectSessionsPaged(projectId, { poll: false, view: 'pinned', limit: SIDE_SECTION_PAGE_SIZE });
  // Shared and Automated load always, one small page each: a section shows
  // only when it has a row, so the drawer must know whether it has one.
  const shared = useProjectSessionsPaged(projectId, {
    poll: false,
    parent: 'root',
    startedBy: 'others',
    limit: SIDE_SECTION_PAGE_SIZE,
  });
  const automated = useProjectSessionsPaged(projectId, {
    poll: false,
    parent: 'root',
    startedBy: 'automated',
    limit: SIDE_SECTION_PAGE_SIZE,
  });
  const {
    isPending: projectSessionsPending,
    isError: projectSessionsErrored,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
    isScanning: mineScanning,
  } = mine;
  // The side sections' "Show more" rows. `fetchNextPage` is stable; the query
  // objects are new on every render, so the list reads these fields, not them.
  // A section reading past empty pages on its own (`isScanning`) reads as
  // loading too, also in the render between two of its pages.
  const sharedFetchingNext = shared.isFetchingNextPage || shared.isScanning;
  const automatedFetchingNext = automated.isFetchingNextPage || automated.isScanning;
  const pinnedFetchingNext = pinned.isFetchingNextPage || pinned.isScanning;
  const fetchNextShared = shared.fetchNextPage;
  const fetchNextAutomated = automated.fetchNextPage;
  const fetchNextPinned = pinned.fetchNextPage;
  const pinnedRows = useMemo(() => sessionsInView(pinned.sessions, 'pinned'), [pinned.sessions]);
  const mineRoots = useMemo(() => rootRowsOnly(mine.sessions), [mine.sessions]);
  const sharedRoots = useMemo(() => rootRowsOnly(shared.sessions), [shared.sessions]);
  const automatedRoots = useMemo(() => rootRowsOnly(automated.sessions), [automated.sessions]);
  // Depends on the `refetch` functions (stable), not the query objects (new on
  // every render): the callback must not change on each fetch's re-render.
  const refetchMine = mine.refetch;
  const refetchShared = shared.refetch;
  const refetchAutomated = automated.refetch;
  const refetchPinned = pinned.refetch;
  const refetchAll = useCallback(async () => {
    await Promise.all([
      refetchMine(),
      refetchPinned(),
      refetchShared(),
      refetchAutomated(),
    ]);
  }, [refetchMine, refetchPinned, refetchShared, refetchAutomated]);
  // Sessions that wait on the user, newest wait first: their own group above
  // the list, from every loaded top-level row. A session not loaded yet (an
  // older page, a child) is left to the Review row's count.
  const needsYouSessions = useMemo(
    () =>
      // One row per session: the four caches can each hold it (`uniqueSessions`).
      uniqueSessions([...pinnedRows, ...mineRoots, ...sharedRoots, ...automatedRoots])
        .filter((session) => needsYouBySession.has(session.session_id))
        .sort(
          (a, b) =>
            (needsYouBySession.get(b.session_id)?.newestAt ?? 0) -
            (needsYouBySession.get(a.session_id)?.newestAt ?? 0)
        ),
    [pinnedRows, mineRoots, sharedRoots, automatedRoots, needsYouBySession]
  );
  const withoutNeedsYou = useCallback(
    (rows: ProjectSession[]) => rows.filter((session) => !needsYouBySession.has(session.session_id)),
    [needsYouBySession]
  );
  // The rows a side section shows from a list of its sessions: not in Needs
  // you, and not claimed by an earlier section (`buildDrawerItems` order).
  const shownCountFor = useCallback(
    (section: SideSection) => {
      const earlier = section === 'pinned' ? [] : [...pinnedRows, ...mineRoots, ...(section === 'automated' ? sharedRoots : [])];
      const claimed = new Set(earlier.map((session) => session.session_id));
      return (rows: ProjectSession[]) =>
        withoutNeedsYou(section === 'pinned' ? sessionsInView(rows, 'pinned') : rootRowsOnly(rows)).filter(
          (session) => !claimed.has(session.session_id)
        ).length;
    },
    [withoutNeedsYou, pinnedRows, mineRoots, sharedRoots]
  );
  // A side section's "Show more": reads pages until the section gains a row
  // it shows, so a press never ends with nothing new on screen. One read per
  // section at a time: the button stays "Loading…" between its pages.
  const [readingMore, setReadingMore] = useState<Partial<Record<SideSection, boolean>>>({});
  const readingMoreRef = useRef<Partial<Record<SideSection, boolean>>>({});
  const showMoreIn = useCallback(
    (section: SideSection) => {
      if (readingMoreRef.current[section]) return;
      const shownRows = shownCountFor(section);
      const [rows, fetchNext] =
        section === 'pinned'
          ? [pinned.sessions, fetchNextPinned]
          : section === 'shared'
            ? [shared.sessions, fetchNextShared]
            : [automated.sessions, fetchNextAutomated];
      const setReading = (value: boolean) => {
        readingMoreRef.current = { ...readingMoreRef.current, [section]: value };
        setReadingMore(readingMoreRef.current);
      };
      setReading(true);
      void fetchUntilShownRowsGrow({ fetchNext: () => fetchNext(), shownCount: shownRows, before: shownRows(rows) }).finally(() =>
        setReading(false)
      );
    },
    [shownCountFor, pinned.sessions, shared.sessions, automated.sessions, fetchNextPinned, fetchNextShared, fetchNextAutomated]
  );
  const isExpanded = useCallback(
    (session: ProjectSession) =>
      isParentExpanded({
        explicit: choices[parentKey(projectId, session.session_id)],
        isActiveParent: session.session_id === activeParentSessionId,
        searchMatch: undefined,
      }),
    [choices, projectId, activeParentSessionId]
  );
  // While the viewer's own list loads, no section renders: Shared (a smaller
  // page, often first back) and Automated (always shown) read as an empty
  // drawer under the loader. Pinned waits too: it lands above every row, and
  // arriving later it would push the list down under the finger.
  const sessionsLoading = projectSessionsPending || pinned.isPending;
  // A side section with no row to show has no header, so no Show more: when
  // its loaded rows all sit in an earlier section or in Needs you and it has
  // a next page, read on once on its own (the same bounded read).
  const autoReadRef = useRef(new Set<string>());
  useEffect(() => {
    if (sessionsLoading) return;
    const sides = [
      ['pinned', pinned],
      ['shared', shared],
      ['automated', automated],
    ] as const;
    for (const [section, query] of sides) {
      const key = `${projectId}:${section}`;
      if (!query.hasNextPage || query.isPending || query.isFetchingNextPage || query.isScanning) continue;
      if (autoReadRef.current.has(key) || shownCountFor(section)(query.sessions) > 0) continue;
      autoReadRef.current.add(key);
      showMoreIn(section);
    }
  });
  const items = useMemo(
    () =>
      sessionsLoading
        ? []
        : buildDrawerItems(
            [
              {
                id: 'pinned',
                title: t('sessions.pinnedSection'),
                rows: withoutNeedsYou(pinnedRows),
                open: sectionOpen('pinned'),
                hasMore: pinned.hasNextPage,
              },
              {
                id: 'sessions',
                title: 'Sessions',
                rows: withoutNeedsYou(mineRoots),
                // A section with no row has no header (`buildDrawerItems`): the
                // state block below (loading, error, empty) speaks for an empty
                // own list, and Needs you for rows that wait on the user.
                open: sectionOpen('sessions'),
                hasMore: hasNextPage,
              },
              {
                id: 'shared',
                title: 'Shared',
                rows: withoutNeedsYou(sharedRoots),
                open: sharedOpen,
                hasMore: shared.hasNextPage,
              },
              {
                id: 'automated',
                title: 'Automated',
                rows: withoutNeedsYou(automatedRoots),
                open: automatedOpen,
                hasMore: automated.hasNextPage,
              },
            ],
            isExpanded
          ),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sectionOpen reads `choices`
    [sessionsLoading, pinnedRows, mineRoots, sharedRoots, automatedRoots, withoutNeedsYou, sharedOpen, automatedOpen, choices, projectId, hasNextPage, pinned.hasNextPage, shared.hasNextPage, automated.hasNextPage, isExpanded, t]
  );
  // loading / error / empty / more / rows — shared with the Sessions page
  // (lib/session/session-pages) so a failed fetch, or a first load paused
  // offline, never reads as "No sessions yet" (COR-146). Judged on the
  // viewer's own list; Shared and Automated add rows, never a verdict: a
  // Shared cursor must not hide the own list's error.
  const sessionsListState = sessionListState({
    isPending: sessionsLoading,
    isError: projectSessionsErrored,
    hasSessions: pinnedRows.length > 0 || mineRoots.length > 0 || sharedRoots.length > 0 || automatedRoots.length > 0,
    hasMore: hasNextPage,
  });
  // Shared and Automated still loading or reading past empty pages: no flower
  // yet, or it would show and then give way to their header. A read paused
  // offline counts as settled: it may wait for a network for good.
  const sideSettled = (query: typeof shared) =>
    query.fetchStatus === 'paused' || (!query.isPending && !query.isScanning);
  const sidesSettled = sideSettled(shared) && sideSettled(automated);
  // The viewer's own list is reading a next page: the footer loader shows.
  const mineLoadingMore = isFetchingNextPage || mineScanning;
  // Only a pull shows the refresh spinner; a background poll does not.
  const [refreshing, setRefreshing] = useState(false);
  const handleRefresh = useCallback(() => {
    setRefreshing(true);
    void refetchAll().finally(() => setRefreshing(false));
  }, [refetchAll]);
  // The drawer stays mounted while closed, so its query never remounts: each
  // open refetches the loaded pages in the background (no spinner), so a
  // session created or renamed elsewhere shows without a pull. After the
  // slide (open is 420ms): a response landing mid-slide re-rendered the list
  // while it moved (Jay, 2026-09-27: "not smooth").
  useRefetchOnOpen(open, refetchAll, DRAWER_REFETCH_DELAY_MS);
  const handleRetrySessions = useCallback(() => {
    haptics.tap();
    void refetchAll();
  }, [refetchAll]);
  const handleShowMoreSessions = useCallback(() => {
    void fetchNextPage();
  }, [fetchNextPage]);
  const handleEndReached = useCallback(() => {
    if (!sectionOpen('sessions')) return;
    if (shouldLoadMoreSessions({ hasNextPage, isFetchingNextPage, isRefreshing: refreshing })) {
      void fetchNextPage();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sectionOpen reads `choices`
  }, [choices, projectId, hasNextPage, isFetchingNextPage, refreshing, fetchNextPage]);
  // The Account page's photo and name, so both surfaces show the same person.
  const profile = useProfileEditor();
  // The avatar's ring colour.
  const planName = useActivePlanName();

  // The list scrolls under the bottom bar's fade; its last row rests above
  // the controls.
  // More room at the drawer's foot (Jay, 2026-11-11): the bar sits
  // DRAWER_BAR_BOTTOM_GAP above the home indicator, and the list ends
  // DRAWER_LIST_END_EXTRA further above the bar.
  const listBottomPadding = usePinnedBarInset(BAR_CONTROL_HEIGHT, DRAWER_BAR_BOTTOM_GAP) + DRAWER_LIST_END_EXTRA;

  // Top fade: follows the scroll offset on the UI thread (no re-render per frame).
  const listScrollY = useSharedValue(0);
  const onListScroll = useAnimatedScrollHandler((event) => {
    listScrollY.value = event.contentOffset.y;
  });
  const topFadeStyle = useAnimatedStyle(() => ({
    opacity: interpolate(listScrollY.value, [0, LIST_TOP_FADE_HEIGHT], [0, 1], Extrapolation.CLAMP),
  }));

  // ── Navigation guard ──
  // A second tap on a pill before the drawer has closed would navigate a
  // second time. The first navigating tap sets the guard; it resets when the
  // drawer's visibility flips (fully closed, or visible again). The drawer
  // content stays mounted while closed, so the reset is driven by the
  // drawer's own progress value, not by mount or a timer.
  const navigatingRef = useRef(false);
  const progress = useDrawerProgress();
  const resetNavigating = useCallback(() => {
    navigatingRef.current = false;
  }, []);
  useAnimatedReaction(
    () => progress.value > DRAWER_CLOSED_PROGRESS,
    (visible, wasVisible) => {
      if (visible !== wasVisible) scheduleOnRN(resetNavigating);
    },
    [resetNavigating]
  );

  /**
   * Close the drawer, then run `navigate` on the next frame. The drawer
   * library starts its close in a layout effect of the commit that sets
   * `open` to false. Navigating in the same tick put the new page's mount
   * (its module graph and first render) into that commit, so the drawer
   * stayed open, frozen, until the page had rendered: up to seconds on a
   * cold page. One frame later the close already runs on the UI thread,
   * and the page renders while the drawer slides away.
   */
  const closeThen = useCallback(
    (navigate: () => void) => {
      onClose();
      requestAnimationFrame(navigate);
    },
    [onClose]
  );

  /**
   * Close the drawer and navigate once. Later taps (any row, any pill) are
   * ignored until reset: the JS thread stays free while the drawer closes, so
   * a second tap would otherwise queue a second navigation. `haptic: false`
   * for a session row: its open path taps itself (ProjectScreen).
   */
  const navigateOnce = useCallback(
    (navigate: () => void, haptic = true) => {
      if (navigatingRef.current) return;
      navigatingRef.current = true;
      if (haptic) haptics.tap();
      closeThen(navigate);
    },
    [closeThen]
  );

  // ── Handlers ──

  // Search opens the Sessions page with its search field already focused —
  // the drawer's only way to it now that the plain "Sessions" row is gone.
  const goToSearch = useCallback(
    () => navigateOnce(() => onNavigateRoute(PROJECT_SESSIONS_ROUTE, { autoFocusSearch: '1' })),
    [navigateOnce, onNavigateRoute]
  );

  const goToFiles = useCallback(
    () => navigateOnce(() => onNavigateRoute(PROJECT_FILES_ROUTE)),
    [navigateOnce, onNavigateRoute]
  );

  const goToArtifacts = useCallback(
    () => navigateOnce(() => onNavigateRoute(PROJECT_ARTIFACTS_ROUTE)),
    [navigateOnce, onNavigateRoute]
  );

  // Review is a tab-store page, not a drawer route: `navigateToPage` alone is
  // enough regardless of which project route is focused (ProjectScreen's old
  // gear button used the same call).
  const goToReview = useCallback(
    () => navigateOnce(() => onOpenPage('page:review')),
    [navigateOnce, onOpenPage]
  );

  // Apps is a tab-store page like Review: one entry point, the drawer pill.
  const goToApps = useCallback(
    () => navigateOnce(() => onOpenPage('page:apps')),
    [navigateOnce, onOpenPage]
  );

  const handleOpenProjectSession = useCallback(
    (session: ProjectSession) => navigateOnce(() => onOpenProjectSession(session), false),
    [navigateOnce, onOpenProjectSession]
  );

  const handleOpenSubsession = useCallback(
    (parent: ProjectSession, childId: string) => navigateOnce(() => onOpenSubsession(parent, childId), false),
    [navigateOnce, onOpenSubsession]
  );

  const toggleParent = useCallback(
    (session: ProjectSession) =>
      setChoice(parentKey(projectId, session.session_id), !isExpanded(session)),
    [setChoice, projectId, isExpanded]
  );

  const renderChild = useCallback(
    (child: ProjectSession, trunkBelow: boolean) => (
      <DrawerSessionNode
        key={child.session_id}
        session={child}
        shown={child.session_id === activeProjectSessionId}
        activeRuntimeId={child.session_id === activeProjectSessionId ? activeRuntimeSessionId : null}
        nested
        trunkBelow={trunkBelow}
        onPress={handleOpenProjectSession}
        onLongPress={onSessionActions}
        onPressSubsession={handleOpenSubsession}
      />
    ),
    [activeProjectSessionId, activeRuntimeSessionId, handleOpenProjectSession, handleOpenSubsession, onSessionActions]
  );

  const renderItem = useCallback(
    ({ item }: { item: DrawerItem }) => {
      if (item.kind === 'header') {
        return (
          <Pressable
            onPress={() => {
              haptics.selection();
              setChoice(sectionKey(projectId, item.section), !item.open);
            }}
            accessibilityRole="button"
            accessibilityLabel={`${item.title}, ${item.open ? 'collapse' : 'expand'}`}
            accessibilityState={{ expanded: item.open }}
            className={`flex-row items-center gap-1 ${ROW_COLUMN} pb-1 pt-3`}>
            <Text variant="muted" className="pl-4">
              {item.title}
            </Text>
            <Icon as={item.open ? CaretDownIcon : CaretRightIcon} size={12} className="text-muted-foreground" />
          </Pressable>
        );
      }
      if (item.kind === 'more') {
        const section = item.section === 'pinned' || item.section === 'shared' ? item.section : 'automated';
        const fetchingNext =
          Boolean(readingMore[section]) ||
          (section === 'pinned' ? pinnedFetchingNext : section === 'shared' ? sharedFetchingNext : automatedFetchingNext);
        return <ShowMoreRow loading={fetchingNext} onPress={() => showMoreIn(section)} />;
      }
      if (item.kind === 'children') {
        return (
          <View className={ROW_COLUMN}>
            <DrawerSessionChildren
              projectId={projectId}
              parent={item.session}
              renderChild={renderChild}
              moreInset={NESTED_SESSION_INDENT}
            />
          </View>
        );
      }
      const shown = item.session.session_id === activeProjectSessionId;
      return (
        <View className={ROW_COLUMN}>
          <DrawerSessionNode
            session={item.session}
            shown={shown}
            activeRuntimeId={shown ? activeRuntimeSessionId : null}
            starter={item.section === 'shared' || item.section === 'automated' ? starterOf(item.session) : undefined}
            expanded={isExpanded(item.session)}
            onToggleChildren={toggleParent}
            onPress={handleOpenProjectSession}
            onLongPress={onSessionActions}
            onPressSubsession={handleOpenSubsession}
          />
        </View>
      );
    },
    [
      projectId,
      pinnedFetchingNext,
      sharedFetchingNext,
      automatedFetchingNext,
      showMoreIn,
      readingMore,
      setChoice,
      renderChild,
      starterOf,
      isExpanded,
      toggleParent,
      activeProjectSessionId,
      activeRuntimeSessionId,
      handleOpenProjectSession,
      handleOpenSubsession,
      onSessionActions,
    ]
  );

  // Needs you scrolls WITH the list, as its header (Jay, 2026-09-27): above
  // it, 20 waiting sessions pushed the list off the screen and it could never
  // be reached. The loading / error / empty state of the viewer's own list
  // sits under it.
  const mutedColor = isDark ? THEME.dark.mutedForeground : THEME.light.mutedForeground;
  const stateBlock = (
    <View className={ROW_COLUMN}>
      {sessionsListState === 'loading' ? (
        <View className="items-center py-8">{open ? <KortixLoader size="small" /> : null}</View>
      ) : sessionsListState === 'error' ? (
        // The query failed and nothing survived to show — never read this as
        // "No sessions yet" (COR-146).
        <View className="items-center gap-2 px-3 py-6">
          <Text variant="small" className="leading-5">
            Couldn&apos;t load sessions
          </Text>
          <Text variant="muted" className="text-center">
            Kortix didn&apos;t respond. Your sessions are safe.
          </Text>
          <View className="mt-1">
            <Button variant="secondary" size="sm" className="rounded-full" onPress={handleRetrySessions}>
              <Text maxFontSizeMultiplier={BUTTON_LABEL_MAX_FONT_SCALE.sm}>Try again</Text>
            </Button>
          </View>
        </View>
      ) : sessionsListState === 'empty' && sidesSettled ? (
        <View className="items-center py-8" accessible accessibilityRole="image" accessibilityLabel="No sessions yet">
          <DrawerEmptyFlower color={mutedColor} />
        </View>
      ) : sessionsListState === 'more' && !mineLoadingMore ? (
        // No row on the pages read so far, and the viewer's own list has a
        // next page (KRTX-1727): offer it. While it loads, the footer loader
        // shows. A Shared or Automated next page has its section's Show more.
        <ShowMoreRow onPress={handleShowMoreSessions} />
      ) : null}
    </View>
  );
  // The nav pills scroll with the list, as its first rows: pinned above it,
  // every new pill took list height away for good.
  const listHeader = useMemo(
    () => (
      <View>
        <View className={ROW_COLUMN}>
          <NavPill icon={MagnifyingGlassIcon} label="Search" onPress={goToSearch} />
          <NavPill icon={FoldersIcon} label="Files" onPress={goToFiles} />
          {showArtifacts ? <NavPill icon={CardsThreeIcon} label={t('artifacts.title')} onPress={goToArtifacts} /> : null}
          {showReview ? (
            <NavPill
              icon={SealCheckIcon}
              label="Review"
              accessibilityLabel={reviewNeedsYouCount > 0 ? `Review, ${reviewNeedsYouCount} pending` : 'Review'}
              onPress={goToReview}
              trailing={<CountBadge count={reviewNeedsYouCount} tone="waiting" />}
            />
          ) : null}
          {showApps ? <NavPill icon={SquaresFourIcon} label="Apps" onPress={goToApps} /> : null}
        </View>
        {needsYouSessions.length > 0 ? (
          <View className={ROW_COLUMN}>
            <Text variant="muted" className="px-4 pb-1 pt-3">
              Needs you
            </Text>
            {needsYouSessions.map((session) => (
              <DrawerSessionNode
                key={session.session_id}
                session={session}
                shown={session.session_id === activeProjectSessionId}
                activeRuntimeId={session.session_id === activeProjectSessionId ? activeRuntimeSessionId : null}
                needsYou={needsYouBySession.get(session.session_id)}
                onPress={handleOpenProjectSession}
                onLongPress={onSessionActions}
                onPressSubsession={handleOpenSubsession}
              />
            ))}
          </View>
        ) : null}
        {sessionsListState === 'rows' ? null : stateBlock}
      </View>
    ),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- stateBlock is derived from the deps below
    [
      goToSearch,
      goToFiles,
      goToArtifacts,
      t,
      goToReview,
      goToApps,
      showReview,
      showApps,
      showArtifacts,
      reviewNeedsYouCount,
      needsYouSessions,
      needsYouBySession,
      sessionsListState,
      sidesSettled,
      mineLoadingMore,
      handleShowMoreSessions,
      open,
      mutedColor,
      handleRetrySessions,
      activeProjectSessionId,
      activeRuntimeSessionId,
      handleOpenProjectSession,
      onSessionActions,
      handleOpenSubsession,
    ]
  );

  const handleNewSession = useCallback(() => {
    navigateOnce(onNewSession);
  }, [navigateOnce, onNewSession]);

  // The app's one settings page (AccountPage), inside the project stack, so
  // its hamburger opens this drawer.
  const goToAccount = useCallback(
    () => navigateOnce(() => onNavigateRoute(PROJECT_ACCOUNT_ROUTE)),
    [navigateOnce, onNavigateRoute]
  );

  const showPageLoader = mineLoadingMore && open;
  const listFooter = useMemo(
    () => (
      <View>
        {showPageLoader ? (
          <View className="items-center py-4">
            <KortixLoader size="small" />
          </View>
        ) : null}
      </View>
    ),
    [showPageLoader]
  );

  // The drawer surface (bg-chrome-background): the bottom bar's fade ends on
  // it, and the top fade (rows scrolling up under the switcher row) starts on it.
  const chrome = isDark ? THEME.dark.chromeBackground : THEME.light.chromeBackground;
  const topFadeColors = [withAlpha(chrome, 1), withAlpha(chrome, 0)] as const;
  const glassy = LIQUID_GLASS_AVAILABLE;
  // New session's glass tint: the primary fill, near-black in light mode and white in dark.
  const primaryFill = isDark ? THEME.dark.primary : THEME.light.primary;

  return (
    // One icon column: nav icons and session status marks each sit in a 20pt
    // slot whose left edge is 20pt from the drawer edge (a 4pt `px-1` column,
    // then the row's `px-4`). `insets.left`: a landscape notch.
    // No fill of its own: the Drawer's root paints the same chrome surface
    // (`useDrawerBackdropColor`), so the page card's soft shadow falls across
    // the sidebar's edge instead of being cut off by it (an opaque sidebar
    // drew a darker band with a hard seam between it and the card).
    <View className="flex-1" style={{ paddingTop: insets.top, paddingLeft: insets.left }}>
      <SwitcherRow
        projectName={project?.name ?? ''}
        projectIcon={project?.icon}
        projectGlyph={project?.icon_glyph}
        onPress={openSwitcher}
      />

      <View className="flex-1">
        <DrawerOpenContext.Provider value={open}>
          {/* Expanded sub-session trees survive virtualisation; the drawer stays
              mounted, so they stay expanded while the project is open. */}
          <SubsessionTreeMemory>
            <Animated.FlatList
              style={{ flex: 1 }}
              data={items}
              keyExtractor={drawerItemKey}
              renderItem={renderItem}
              showsVerticalScrollIndicator={false}
              onScroll={onListScroll}
              scrollEventThrottle={16}
              contentContainerStyle={{ paddingBottom: listBottomPadding }}
              ListHeaderComponent={listHeader}
              // Load the next page about one screen before the end of the list.
              onEndReached={handleEndReached}
              onEndReachedThreshold={0.6}
              refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor={mutedColor} />}
              ListFooterComponent={listFooter}
            />
          </SubsessionTreeMemory>
        </DrawerOpenContext.Provider>
        {/* Top fade: rows fade out under the switcher row instead of a hard edge. */}
        <Animated.View
          pointerEvents="none"
          style={[{ position: 'absolute', top: 0, left: 0, right: 0, height: LIST_TOP_FADE_HEIGHT }, topFadeStyle]}>
          <LinearGradient colors={topFadeColors} style={StyleSheet.absoluteFill} />
        </Animated.View>
      </View>

      {/* Avatar left, New session right (Jay, 2026-09-23), over the drawer
          surface's fade. On iOS 26 each is a Liquid Glass button (the Button
          draws inside the glass). New session is the primary pill: black
          with white text in light mode, inverted in dark (Jay, 2026-11-11);
          on iOS 26 that is glass tinted in the primary colour, elsewhere the
          solid primary fill. */}
      <PinnedBar controlHeight={BAR_CONTROL_HEIGHT} background={chrome} blur dark={isDark} bottomGap={DRAWER_BAR_BOTTOM_GAP} className="justify-between px-5">
        <GlassButtons>
          <Button
            variant="ghost"
            size="icon-lg"
            className="rounded-full"
            onPress={goToAccount}
            accessibilityLabel={planName ? `Account, ${planName} plan` : 'Account'}
            hitSlop={2}>
            {/* The avatar wears its plan's gradient ring. */}
            <View pointerEvents="none">
              <PlanRingAvatar
                imageUrl={profile.avatarUrl}
                fallbackText={profile.displayName}
                email={profile.email}
                planName={planName}
                size={glassy ? AVATAR_ON_GLASS : BAR_CONTROL_HEIGHT}
                gapColor={chrome}
              />
            </View>
          </Button>
        </GlassButtons>
        <GlassButtons tintColor={primaryFill}>
          <Button
            size="lg"
            variant="default"
            // On glass the tint is the fill: the solid primary would hide the glass.
            className={glassy ? 'rounded-full bg-transparent dark:bg-transparent' : 'rounded-full'}
            onPress={handleNewSession}>
            {/* A plus, as the Claude iOS sidebar's New session (Jay, 2026-11-11). */}
            <Icon as={PlusIcon} size={20} />
            <Text maxFontSizeMultiplier={BUTTON_LABEL_MAX_FONT_SCALE.lg}>New session</Text>
          </Button>
        </GlassButtons>
      </PinnedBar>
    </View>
  );
});
