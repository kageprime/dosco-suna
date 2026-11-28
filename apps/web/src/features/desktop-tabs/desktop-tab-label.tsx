'use client';

import Hint from '@kortix/ui/hint';

import { directSubsessions, sessionParentId, type Artifact, type ProjectSession } from '@kortix/sdk';
import { useArtifact, useCachedWorkspaceSessions, useFeatureFlag, useProjectApps, useProjectSession, useWorkspaceSessionGroups } from '@kortix/sdk/react';
import { cn } from '@kortix/ui';
import { ProjectFilesProvider } from '@kortix/ui/files/project/context';
import { useSessionChangeRequests } from '@kortix/ui/files/project/hooks/use-change-requests';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@kortix/ui/hover-card';
import { AgentMarkGlyph, agentMarkVars } from '@kortix/ui/internal/components/agent-mark';
import { CustomizeGlyph } from '@kortix/ui/internal/layout/project-settings-nav';
import { getSessionDisplayTitle } from '@kortix/ui/session/actions/project-session-list-helpers';
import { sessionDisplayStatus, sessionSource, type SessionDisplayStatus } from '@kortix/ui/session/actions/session-label';
import { SessionStatusMark } from '@kortix/ui/session/list/session-status-mark';
import { SpaceIconBare } from '@kortix/ui/workspace/session-spaces/space-icon';
import { SessionBriefContent } from '@kortix/ui/workspace/sidebar/session-brief-hover-card';
import { AppWindowIcon, BookOpenTextIcon, BrainIcon, BrowserIcon, CalendarBlankIcon, CardsThreeIcon, ChartBarIcon, ChatsCircleIcon, CheckCircleIcon, ClockCounterClockwiseIcon, CpuIcon, CreditCardIcon, CubeIcon, FileTextIcon, FoldersIcon, GearSixIcon, GitBranchIcon, GitDiffIcon, HardDrivesIcon, HashIcon, IdentificationBadgeIcon, KeyIcon, ListBulletsIcon, NavigationArrowIcon, PaletteIcon, PlugsConnectedIcon, QuestionIcon, RepeatIcon, ShieldCheckIcon, SquaresFourIcon, StackIcon, TargetIcon, TimerIcon, TrayIcon, UsersIcon, UsersThreeIcon, type Icon } from '@phosphor-icons/react';
import { formatDistanceToNowStrict } from 'date-fns';
import { createContext, useContext, type ReactNode } from 'react';
import { useTranslations } from '@/i18n/use-translations';
import { isPrototypeKey, ownEntry, type TabRoute } from './tab-route';
/* ─── Session signals: the sidebar's own data ─────────────────────────────── */

interface SessionSignals {
  /** A session's row in the polled session lists the sidebar reads. */
  rows: ReadonlyMap<string, ProjectSession>;
  needsYou: Record<string, number>;
  awaitingAnswer: ReadonlySet<string>;
}

const SessionSignalsContext = createContext<SessionSignals | null>(null);

export const SessionSignalsProvider = SessionSignalsContext.Provider;

type Translate = ReturnType<typeof useTranslations>;

/* ─── Icon + title ────────────────────────────────────────────────────────── */

export function TabLabel({
  route,
  projectId,
  pinned,
  preview,
  t,
}: {
  route: TabRoute | null;
  projectId: string;
  pinned: boolean;
  /** The preview tab: its title is italic, the editor convention. */
  preview: boolean;
  t: Translate;
}) {
  return (
    <span className={cn('flex min-w-0 flex-1 self-stretch', preview && 'italic')}>
      <TabLabelBody route={route} projectId={projectId} pinned={pinned} t={t} />
    </span>
  );
}

function TabLabelBody({
  route,
  projectId,
  pinned,
  t,
}: {
  route: TabRoute | null;
  projectId: string;
  pinned: boolean;
  t: Translate;
}) {
  // The Project admin rail's own names, so a tab reads exactly like its row.
  const tSections = useTranslations('workspaces.settings.sections');
  if (route?.kind === 'session') {
    return <SessionLabel projectId={projectId} sessionId={route.sessionId} pinned={pinned} t={t} />;
  }
  if (route?.kind === 'artifact') {
    return (
      <ArtifactLabel projectId={projectId} artifactId={route.artifactId} pinned={pinned} t={t} />
    );
  }
  if (route?.kind === 'app') {
    return <AppLabel projectId={projectId} appId={route.appId} pinned={pinned} t={t} />;
  }
  if (route?.kind === 'sessionSpace') {
    return (
      <SessionSpaceLabel projectId={projectId} groupId={route.groupId} pinned={pinned} t={t} />
    );
  }
  if (route?.kind === 'agent') {
    return (
      <Label
        pinned={pinned}
        title={route.name}
        icon={
          <span
            style={agentMarkVars(route.name)}
            className="flex size-4 items-center justify-center"
          >
            <AgentMarkGlyph slug={route.name} size={14} />
          </span>
        }
      />
    );
  }
  const { icon: IconComponent, title } = staticLabel(route, t, tSections);
  return (
    <Label
      pinned={pinned}
      title={title}
      icon={
        IconComponent === 'customize' ? (
          <span className="flex size-4 items-center justify-center [&_svg]:size-3.5">
            <CustomizeGlyph />
          </span>
        ) : (
          <IconComponent className="size-3.5 shrink-0" />
        )
      }
    />
  );
}

function SessionLabel({
  projectId,
  sessionId,
  pinned,
  t,
}: {
  projectId: string;
  sessionId: string;
  pinned: boolean;
  t: Translate;
}) {
  const signals = useContext(SessionSignalsContext);
  const listed = signals?.rows.get(sessionId);
  // Only a session outside the loaded lists needs its own read.
  const own = useProjectSession(projectId, sessionId, { enabled: !listed });
  const session = listed ?? own.data;
  if (!session && own.isError) {
    return (
      <Label
        pinned={pinned}
        title={t('unavailable')}
        pending
        icon={<BrowserIcon className="size-3.5 shrink-0" />}
      />
    );
  }
  // The sidebar row's inputs (project-session-list.tsx), so the glyph agrees
  // with the row: review count, and an open question over a review. Not the
  // overdue tint (yellow after 24 h): that needs the sidebar's change-request
  // list, and the tab keeps the blue "needs you" glyph instead.
  const reviewCount = signals?.needsYou[sessionId] ?? 0;
  const waitingOn = signals?.awaitingAnswer.has(sessionId) ? 'answer' : 'review';
  const status = session ? sessionDisplayStatus(session, reviewCount) : null;
  return (
    <Label
      pinned={pinned}
      title={session ? getSessionDisplayTitle(session) : t('session')}
      pending={!session}
      card={
        session && status ? (
          <SessionTabCard
            projectId={projectId}
            session={session}
            status={status}
            waitingOn={waitingOn}
          />
        ) : undefined
      }
      icon={
        session ? (
          <SessionStatusMark status={status ?? 'done'} waitingOn={waitingOn} />
        ) : (
          <span className="bg-muted-foreground size-1.5 rounded-full" />
        )
      }
    />
  );
}

/** The open App's name, from the project's App list (cached by the Apps page). */
function AppLabel({
  projectId,
  appId,
  pinned,
  t,
}: {
  projectId: string;
  appId: string;
  pinned: boolean;
  t: Translate;
}) {
  const { data: apps } = useProjectApps(projectId);
  const app = apps?.find((item) => item.app_id === appId || item.slug === appId);
  return (
    <Label
      pinned={pinned}
      title={app?.name ?? t('pages.apps')}
      icon={<AppWindowIcon className="size-3.5 shrink-0" />}
    />
  );
}

/** One Space: its name and icon, as the sidebar shows it (the same cached list). */
function SessionSpaceLabel({
  projectId,
  groupId,
  pinned,
  t,
}: {
  projectId: string;
  groupId: string;
  pinned: boolean;
  t: Translate;
}) {
  const tSpaces = useTranslations('sessionSpaces');
  const flag = useFeatureFlag(projectId, 'session_groups');
  const groups = useWorkspaceSessionGroups(projectId, { enabled: flag.enabled });
  const space = groups.data?.find((group) => group.group_id === groupId);
  if (space) {
    return (
      <Label
        pinned={pinned}
        title={space.name}
        icon={<SpaceIconBare space={space} className="size-3.5" />}
      />
    );
  }
  // Loaded, and the space is not there: deleted, or no longer shared with you.
  const gone = groups.isSuccess;
  return (
    <Label
      pinned={pinned}
      title={gone ? t('unavailable') : tSpaces('title')}
      pending={gone}
      icon={<StackIcon className="size-3.5 shrink-0" />}
    />
  );
}

function ArtifactLabel({
  projectId,
  artifactId,
  pinned,
  t,
}: {
  projectId: string;
  artifactId: string;
  pinned: boolean;
  t: Translate;
}) {
  const { data: artifact, isError } = useArtifact(projectId, artifactId);
  if (!artifact && isError) {
    return (
      <Label
        pinned={pinned}
        title={t('unavailable')}
        pending
        icon={<BrowserIcon className="size-3.5 shrink-0" />}
      />
    );
  }
  const TypeIcon = artifact?.type === 'html' ? BrowserIcon : FileTextIcon;
  return (
    <Label
      pinned={pinned}
      title={artifact?.title || t('artifact')}
      pending={!artifact}
      card={artifact ? <ArtifactTabCard artifact={artifact} /> : undefined}
      icon={<TypeIcon className="size-3.5 shrink-0" />}
    />
  );
}

function Label({
  icon,
  title,
  pinned,
  pending,
  card,
}: {
  icon: ReactNode;
  title: string;
  pinned: boolean;
  pending?: boolean;
  /** A page with more to say than its name (a session, an artifact) shows a card on hover. */
  card?: ReactNode;
}) {
  const body = (
    <span
      className={cn(
        // The hover target is the whole chip, not just its text: full height,
        // and pulled over the tab's left padding (`-ml-2 pl-2` cancels the
        // tab's `pl-2`), so a card opens flush with the tab's own left edge.
        'flex min-w-0 flex-1 items-center gap-1.5 self-stretch',
        // Icon only (pinned, or too narrow for text): centre it in the chip.
        pinned ? 'justify-center' : '-ml-2 pl-2 @max-[2.75rem]:justify-center',
      )}
    >
      <span className="flex size-4 shrink-0 items-center justify-center" aria-hidden>
        {icon}
      </span>
      <span
        className={cn(
          // Truncates into the tab's fill instead of an ellipsis. Too narrow
          // for text, the title stays the tab's accessible name.
          'min-w-0 flex-1 overflow-hidden [mask-image:linear-gradient(to_right,black_calc(100%-1rem),transparent)] whitespace-nowrap @max-[2.75rem]:sr-only',
          pinned && 'sr-only',
          pending && 'text-muted-foreground',
        )}
      >
        {title}
      </span>
    </span>
  );
  if (card) {
    return (
      <HoverCard openDelay={1000} closeDelay={150}>
        <HoverCardTrigger asChild>{body}</HoverCardTrigger>
        <HoverCardContent
          side="bottom"
          align="start"
          sideOffset={6}
          className="w-72 overflow-hidden p-0"
        >
          {card}
        </HoverCardContent>
      </HoverCard>
    );
  }
  // No tooltip: the title is on the tab. Only a pinned tab, which shows its
  // icon alone, names itself on hover.
  if (!pinned) return body;
  return (
    <Hint side="bottom" label={title}>
      {body}
    </Hint>
  );
}

/* ─── Hover cards ─────────────────────────────────────────────────────────── */

/**
 * A session tab's card: the sidebar's own session brief (status, goal, sub-
 * agents and spawned sessions, source, labels, the change requests it opened
 * with links into Review), plus the session that spawned it. Mounted only while
 * the card is open, so its reads (this session's change requests, a parent not
 * in any list) start on hover, never for every tab.
 */
function SessionTabCard({
  projectId,
  session,
  status,
  waitingOn,
}: {
  projectId: string;
  session: ProjectSession;
  status: SessionDisplayStatus;
  waitingOn: 'answer' | 'review';
}) {
  return (
    <ProjectFilesProvider value={{ projectId, ref: '' }}>
      <SessionTabCardBody
        projectId={projectId}
        session={session}
        status={status}
        waitingOn={waitingOn}
      />
    </ProjectFilesProvider>
  );
}

function SessionTabCardBody({
  projectId,
  session,
  status,
  waitingOn,
}: {
  projectId: string;
  session: ProjectSession;
  status: SessionDisplayStatus;
  waitingOn: 'answer' | 'review';
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const { data: crs } = useSessionChangeRequests(session.session_id);
  const parentId = sessionParentId(session);
  const cachedParent = useCachedWorkspaceSessions(projectId, parentId ? [parentId] : []).get(
    parentId ?? '',
  );
  const ownParent = useProjectSession(projectId, parentId ?? '', {
    enabled: !!parentId && !cachedParent,
  });
  const parentRow = cachedParent ?? ownParent.data;
  return (
    <SessionBriefContent
      sessionId={session.session_id}
      projectId={projectId}
      title={getSessionDisplayTitle(session)}
      status={status}
      waitingOn={waitingOn}
      createdAt={session.created_at}
      source={sessionSource(session, tI18nComplete)}
      changeRequests={crs?.change_requests ?? []}
      labels={session.labels}
      spawned={!!parentId}
      parent={
        parentId && parentRow
          ? {
              title: getSessionDisplayTitle(parentRow),
              href: `/workspaces/${projectId}/sessions/${parentId}`,
            }
          : undefined
      }
      subagentCount={directSubsessions(session).length}
      spawnedCount={session.child_count ?? 0}
      onDismiss={noop}
    />
  );
}

const noop = () => {};

/** An artifact tab's card: what it is, where it lives in Files, who can see it, when it changed. */
function ArtifactTabCard({ artifact }: { artifact: Artifact }) {
  const t = useTranslations('artifacts');
  const TypeIcon = artifact.type === 'html' ? BrowserIcon : FileTextIcon;
  return (
    <div className="space-y-1.5 px-3.5 py-2.5">
      <p className="text-foreground truncate text-sm font-medium">{artifact.title}</p>
      {artifact.description ? (
        <p className="text-muted-foreground line-clamp-2 text-xs">{artifact.description}</p>
      ) : null}
      <div className="text-muted-foreground flex items-center gap-2 text-xs">
        <TypeIcon aria-hidden className="size-4 shrink-0" />
        <span>{t(`type.${artifact.type}`)}</span>
        <span aria-hidden>·</span>
        <span>{t(`visibility.${artifact.visibility}`)}</span>
      </div>
      <div className="text-muted-foreground flex min-w-0 items-center gap-2 text-xs">
        <FoldersIcon aria-hidden className="size-4 shrink-0" />
        <span className="min-w-0 truncate font-mono">{artifact.path}</span>
      </div>
      <div className="text-muted-foreground flex items-center gap-2 text-xs">
        <ClockCounterClockwiseIcon aria-hidden className="size-4 shrink-0" />
        <span suppressHydrationWarning>
          {t('updated', {
            time: formatDistanceToNowStrict(new Date(artifact.updated_at), { addSuffix: true }),
          })}
        </span>
      </div>
    </div>
  );
}

/** The sidebar's New session glyph: a paper plane pointing right. */
function NewSessionIcon({ className }: { className?: string }) {
  return <NavigationArrowIcon className={cn('rotate-90', className)} />;
}

const ADMIN_ICONS: Record<string, Icon> = {
  agents: SquaresFourIcon,
  connectors: PlugsConnectedIcon,
  secrets: KeyIcon,
  skills: BookOpenTextIcon,
  drives: HardDrivesIcon,
  apps: AppWindowIcon,
  triggers: TimerIcon,
  models: CpuIcon,
  repo: FoldersIcon,
  review: GitDiffIcon,
  reminders: RepeatIcon,
  members: UsersIcon,
  general: GearSixIcon,
  security: ShieldCheckIcon,
  branding: PaletteIcon,
  'api-keys': KeyIcon,
  sandbox: CubeIcon,
  git: GitBranchIcon,
  groups: UsersThreeIcon,
  roles: IdentificationBadgeIcon,
  identity: IdentificationBadgeIcon,
  audit: ClockCounterClockwiseIcon,
  help: QuestionIcon,
  plan: CreditCardIcon,
  usage: ChartBarIcon,
  evals: ChartBarIcon,
  'eval-jobs': ChartBarIcon,
  'eval-tasks': ChartBarIcon,
  'eval-datasets': ChartBarIcon,
  settings: GearSixIcon,
};

const SECTION_LABEL: Record<string, string> = {
  agents: 'agents',
  connectors: 'connectors',
  secrets: 'secrets',
  skills: 'skills',
  drives: 'drives',
  apps: 'apps',
  triggers: 'triggers',
  models: 'models',
  repo: 'repo',
  review: 'review',
  reminders: 'reminders',
  members: 'members',
  settings: 'settings',
};

function staticLabel(
  route: TabRoute | null,
  t: Translate,
  tSections: Translate,
): { icon: Icon | typeof NewSessionIcon | 'customize'; title: string } {
  if (!route) return { icon: BrowserIcon, title: t('page') };
  switch (route.kind) {
    case 'home':
      // Home is where a new session starts: the tab reads like the sidebar's row.
      return { icon: NewSessionIcon, title: t('newSession') };
    case 'sessions':
      return { icon: ListBulletsIcon, title: t('sessions') };
    case 'artifacts':
      return { icon: CardsThreeIcon, title: t('artifacts') };
    case 'admin':
    case 'customize': {
      const section = route.section;
      const icon = ownEntry(ADMIN_ICONS, section) ?? 'customize';
      if (!section) return { icon, title: t('customize') };
      // `api-keys` → `apiKeys`: the rail catalog keys are camelCase.
      const railKey = section.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
      if (!isPrototypeKey(railKey) && tSections.has(railKey)) {
        return { icon, title: tSections(railKey) };
      }
      const own = ownEntry(SECTION_LABEL, section);
      return { icon, title: own ? t(`sections.${own}`) : t('customize') };
    }
    case 'goal':
      return { icon: TargetIcon, title: t('goal') };
    case 'channel':
      return { icon: HashIcon, title: route.slug };
    case 'dm':
      return { icon: ChatsCircleIcon, title: route.agent };
    case 'space':
      return { icon: HashIcon, title: route.slug };
    case 'settings':
      return { icon: GearSixIcon, title: t('settings') };
    case 'page': {
      const icons: Record<typeof route.page, Icon> = {
        apps: AppWindowIcon,
        calendar: CalendarBlankIcon,
        chat: ChatsCircleIcon,
        drive: HardDrivesIcon,
        files: FoldersIcon,
        goals: TargetIcon,
        inbox: TrayIcon,
        memory: BrainIcon,
        members: UsersIcon,
        review: GitDiffIcon,
        setup: CheckCircleIcon,
      };
      return { icon: icons[route.page], title: t(`pages.${route.page}`) };
    }
    case 'section':
      return { icon: BrowserIcon, title: t('page') };
  }
  return { icon: BrowserIcon, title: t('page') };
}
