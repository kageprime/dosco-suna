'use client';

import { useFeatureFlag } from '@kortix/sdk/react';
import {
  AppWindowIcon,
  CalendarBlankIcon,
  CardsThreeIcon,
  CheckIcon,
  FoldersIcon,
  HardDrivesIcon,
  PushPinIcon,
  TargetIcon,
} from '@phosphor-icons/react';
import { useCallback, useMemo, useSyncExternalStore, type ReactNode } from 'react';

import { useTranslations } from '../../i18n';
import { filesRow } from '../../internal/layout/files-nav-label';
import { useCapabilityAccess, useProjectNavRows } from '../../internal/layout/project-settings-nav';
import { reviewHref } from '../../internal/lib/capability-tab-routes';
import { uiRoutes } from '../../lib/routes';
import { cn } from '../../lib/utils';
import { useUiPathname } from '../../providers/ui-provider';
import { useAppsRowVisible } from './footer/project-apps-nav';
import { useArtifactsRowVisible } from './footer/project-artifacts-nav';
import { useGoalsRowVisible } from './footer/project-goals-nav';

/** The pages of the rail's More menu a person can pin to the rail. Customize has its own rail button. */
export const PINNABLE_PAGES = ['review', 'files', 'apps', 'calendar', 'goals', 'artifacts'] as const;
export type PinnablePage = (typeof PINNABLE_PAGES)[number];

const storageKey = (projectId: string) => `kortix:rail-pins:${projectId}`;

function readRaw(projectId: string): string {
  try {
    return localStorage.getItem(storageKey(projectId)) ?? '[]';
  } catch {
    return '[]';
  }
}

function parsePins(raw: string): PinnablePage[] {
  try {
    const list: unknown = JSON.parse(raw);
    return Array.isArray(list)
      ? list.filter((id): id is PinnablePage => (PINNABLE_PAGES as readonly unknown[]).includes(id))
      : [];
  } catch {
    return [];
  }
}

// replica-local: the pin listeners of this tab; other tabs arrive through the `storage` event.
const listeners = new Set<() => void>();
function subscribe(listener: () => void) {
  listeners.add(listener);
  window.addEventListener('storage', listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', listener);
  };
}

/**
 * The pages this person pinned to the rail, in pin order. A per-viewer
 * convenience kept in this browser (localStorage, per workspace): a private
 * window or cleared site data starts with none. The server render has none.
 */
export function useRailPins(projectId: string): { pins: PinnablePage[]; toggle: (id: PinnablePage) => void } {
  const raw = useSyncExternalStore(subscribe, () => readRaw(projectId), () => '[]');
  const pins = useMemo(() => parsePins(raw), [raw]);
  const toggle = useCallback(
    (id: PinnablePage) => {
      const current = parsePins(readRaw(projectId));
      const next = current.includes(id) ? current.filter((pin) => pin !== id) : [...current, id];
      try {
        localStorage.setItem(storageKey(projectId), JSON.stringify(next));
      } catch {
        // Storage refused (private window): the pin is not kept.
      }
      listeners.forEach((listener) => listener());
    },
    [projectId],
  );
  return { pins, toggle };
}

/**
 * A row of the More menu with its pin at the right edge: an outline pin on
 * hover or focus, a filled pin while the page is pinned. A click pins or
 * unpins. The wrapper hides when the row renders nothing (a page this
 * workspace does not offer), so no orphan pin is left.
 */
export function PinnableRow({
  pinned,
  onToggle,
  children,
}: {
  pinned: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const t = useTranslations('sidebar.iconRail');
  return (
    <div className="group/pin relative [&:not(:has(li))]:hidden">
      {children}
      <button
        type="button"
        aria-label={pinned ? t('unpinTab') : t('pinTab')}
        aria-pressed={pinned}
        onClick={(event) => {
          // The row is a link; the pin must not follow it or close the menu.
          event.preventDefault();
          event.stopPropagation();
          onToggle();
        }}
        className={cn(
          'text-muted-foreground hover:text-foreground focus-visible:text-foreground absolute top-1/2 right-2 flex size-6 -translate-y-1/2 items-center justify-center transition-colors focus-visible:outline-none [&_svg]:size-4',
          pinned ? 'opacity-100' : 'opacity-0 group-focus-within/pin:opacity-100 group-hover/pin:opacity-100',
        )}
      >
        <PushPinIcon weight={pinned ? 'fill' : 'regular'} />
      </button>
    </div>
  );
}

/** What a pinned rail item draws: its link, name and icon. Null: the page is not offered here. */
type PinnedPage = { href: string; label: string; icon: ReactNode } | null;

function usePinnedReview(projectId: string): PinnedPage {
  const t = useTranslations('sidebar');
  const access = useCapabilityAccess(projectId);
  const href = reviewHref(projectId);
  if (!href || !access.settled || !access.tabs.includes('review')) return null;
  return { href, label: t('spaces.review'), icon: <CheckIcon /> };
}

function usePinnedFiles(projectId: string): PinnedPage {
  const t = useTranslations('sidebar');
  const target = useProjectNavRows(projectId).files;
  const row = target ? filesRow(projectId, target) : null;
  if (!row) return null;
  return { href: row.href, label: t(row.label), icon: row.label === 'drive' ? <HardDrivesIcon /> : <FoldersIcon /> };
}

function usePinnedApps(projectId: string): PinnedPage {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const visible = useAppsRowVisible(projectId);
  const href = uiRoutes().apps(projectId);
  if (!visible || !href) return null;
  return { href, label: tI18nComplete.raw('text89dd748442c1'), icon: <AppWindowIcon /> };
}

function usePinnedCalendar(projectId: string): PinnedPage {
  const t = useTranslations('sidebar');
  const visible = useFeatureFlag(projectId, 'calendar').enabled;
  const href = uiRoutes().calendar?.(projectId) ?? null;
  if (!visible || !href) return null;
  return { href, label: t('calendar'), icon: <CalendarBlankIcon /> };
}

function usePinnedGoals(projectId: string): PinnedPage {
  const t = useTranslations('sidebar');
  const visible = useGoalsRowVisible(projectId);
  const href = uiRoutes().goals(projectId);
  if (!visible || !href) return null;
  return { href, label: t('goals'), icon: <TargetIcon /> };
}

function usePinnedArtifacts(projectId: string): PinnedPage {
  const t = useTranslations('sidebar');
  const visible = useArtifactsRowVisible(projectId);
  const href = uiRoutes().artifacts(projectId);
  if (!visible || !href) return null;
  return { href, label: t('artifacts'), icon: <CardsThreeIcon /> };
}

const PINNED_HOOKS: Record<PinnablePage, (projectId: string) => PinnedPage> = {
  review: usePinnedReview,
  files: usePinnedFiles,
  apps: usePinnedApps,
  calendar: usePinnedCalendar,
  goals: usePinnedGoals,
  artifacts: usePinnedArtifacts,
};

/**
 * One pinned page on the rail. Each id is its own component, so its hook
 * order never changes between renders.
 */
export function PinnedRailItem({
  projectId,
  id,
  render,
}: {
  projectId: string;
  id: PinnablePage;
  render: (page: NonNullable<PinnedPage>, current: boolean) => ReactNode;
}) {
  const page = PINNED_HOOKS[id](projectId);
  const pathname = useUiPathname();
  if (!page) return null;
  const path = page.href.split('?')[0]!;
  const current = !!pathname && (pathname === path || pathname.startsWith(`${path}/`));
  return <>{render(page, current)}</>;
}
