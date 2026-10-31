'use client';

import { useMemo } from 'react';
import {
  SparkleIcon,
  LightningIcon,
  CpuIcon,
  PlugsConnectedIcon,
  LaptopIcon,
  ClockAfternoonIcon,
  KeyIcon,
  GearSixIcon,
  GitBranchIcon,
  ShippingContainerIcon,
  FlaskIcon,
  ArrowCircleUpIcon,
  UsersIcon,
  TrayIcon,
  FolderIcon,
  ArrowUpRightIcon,
  type Icon,
} from '@phosphor-icons/react';
import { getProjectDetail } from '@kortix/sdk';
import { contract, qk } from '@kortix/sdk/react';
import { useQuery } from '@tanstack/react-query';

import { useTranslations } from '../../i18n';
import { useLocalizedUiCatalog } from '../../i18n/ui-catalog/use-localized-ui-catalog';
import { hubTarget } from '../../internal/stores/account-panel-store';
import { HubLink } from '../../internal/account-hub/account-hub-location';
import { SidebarToggle } from '../../internal/layout/sidebar-toggle';
import { useOptionalSidebar } from '../../primitives/sidebar';
import { useCapabilityAccess } from '../../internal/layout/project-settings-nav';
import { PROJECT_ACTIONS } from '../../internal/lib/project-actions';
import { useProjectPageCans } from '../../internal/lib/use-project-can';
import { useReviewSessionSummary } from '../../internal/hooks/use-review-session-summary';
import { detectManifestVersion } from '../../internal/lib/manifest-version';
import { cn } from '../../internal/lib/utils';
import { UiLink as Link, useUiPathname, useUiSearchParams } from '../../providers/ui-provider';
import { CountBadge } from '../../primitives/count-badge';
import {
  CAPABILITY_TABS,
  activeCapabilityTab,
  capabilityTabHref,
  type CapabilityTab,
} from '../../internal/lib/capability-tab-routes';
import {
  DEFAULT_PROJECT_SETTINGS_SECTION,
  parseProjectSettingsSection,
  projectSettingsSectionHref,
  projectSettingsSections,
  type ProjectSettingsSectionKey,
} from '../project-settings/project-settings-sections';
import { receivedDenial } from './capability-access-gate';

interface NavItem {
  id: string;
  label: string;
  href: string;
  icon: Icon;
  isActive: boolean;
  count?: number;
  attention?: boolean;
  external?: boolean;
}

interface NavGroup {
  id: string;
  title: string;
  items: NavItem[];
}

/**
 * CustomizeSidebar — Supabase-style unified secondary vertical sidebar for project customization.
 * Eliminates horizontal tabs and consolidates Intelligence, Connectivity, and Project Settings
 * into a structured, dual-rail layout.
 */
export function CustomizeSidebar({
  projectId,
  className,
}: {
  projectId: string;
  className?: string;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const pathname = useUiPathname();
  const searchParams = useUiSearchParams();
  const sidebar = useOptionalSidebar();

  const activeTabKey = activeCapabilityTab(pathname);
  const isSettingsActive = activeTabKey === 'config' || pathname.includes('/settings');
  const rawSection = searchParams.get('section');
  const activeSectionKey: ProjectSettingsSectionKey =
    parseProjectSettingsSection(rawSection) ?? DEFAULT_PROJECT_SETTINGS_SECTION;

  // Access probes
  const access = useCapabilityAccess(projectId);
  const allowedTabs = new Set(access.tabs);

  // Project detail query for upgrades and account ID
  const detail = useQuery({
    queryKey: qk.project.detail(projectId),
    queryFn: () => getProjectDetail(projectId),
    enabled: !!projectId,
    ...contract('config'),
  });
  const project = detail.data?.project;
  const upgradeAttention = detail.data
    ? detectManifestVersion(detail.data.config.manifest_raw) === 1
    : false;

  // Review summary count
  const reviewNeedsYou = useReviewSessionSummary(projectId).totalNeedsYou;

  // Members can check
  const canReadMembers = useProjectPageCans(projectId)[PROJECT_ACTIONS.PROJECT_MEMBERS_READ];
  const accountId = project?.account_id;
  const showMembers = !receivedDenial(canReadMembers);

  // Settings sections
  const settingsSections = useMemo(
    () => projectSettingsSections(tI18nComplete),
    [tI18nComplete],
  );

  // Group definitions
  const groups = useMemo((): NavGroup[] => {
    // 1. INTELLIGENCE (Agents, Skills, Models)
    const intelligenceItems: NavItem[] = [
      {
        id: 'agents',
        label: 'Agents',
        href: capabilityTabHref(projectId, 'agent'),
        icon: SparkleIcon,
        isActive: activeTabKey === 'agent',
      },
      {
        id: 'skills',
        label: 'Skills',
        href: capabilityTabHref(projectId, 'skills'),
        icon: LightningIcon,
        isActive: activeTabKey === 'skills',
      },
      {
        id: 'models',
        label: 'Models',
        href: capabilityTabHref(projectId, 'models'),
        icon: CpuIcon,
        isActive: activeTabKey === 'models',
      },
    ];

    // 2. CONNECTIVITY (Connectors, Computer, Triggers, Secrets)
    const connectivityItems: NavItem[] = [
      {
        id: 'connectors',
        label: 'Connectors',
        href: capabilityTabHref(projectId, 'connectors'),
        icon: PlugsConnectedIcon,
        isActive: activeTabKey === 'connectors',
      },
      {
        id: 'computer',
        label: 'Computer',
        href: `/projects/${projectId}/settings/computer`,
        icon: LaptopIcon,
        isActive: pathname.includes('/settings/computer'),
      },
      {
        id: 'triggers',
        label: 'Triggers',
        href: capabilityTabHref(projectId, 'triggers'),
        icon: ClockAfternoonIcon,
        isActive: activeTabKey === 'triggers',
      },
      {
        id: 'secrets',
        label: 'Secrets',
        href: capabilityTabHref(projectId, 'secrets'),
        icon: KeyIcon,
        isActive: activeTabKey === 'secrets',
      },
    ];

    // 3. PROJECT SETTINGS (General, Git repo, Sandboxes, Flags, Upgrades)
    const settingsItems: NavItem[] = settingsSections.map((sec) => ({
      id: sec.key,
      label: sec.label,
      href: projectSettingsSectionHref(projectId, sec.key),
      icon: sec.icon,
      isActive: isSettingsActive && activeSectionKey === sec.key,
      attention: (sec.key as string) === 'upgrades' && upgradeAttention,
    }));

    // 4. ACCESS & REVIEW
    const accessItems: NavItem[] = [];

    if (allowedTabs.has('review')) {
      accessItems.push({
        id: 'review',
        label: 'Review',
        href: capabilityTabHref(projectId, 'review'),
        icon: TrayIcon,
        isActive: activeTabKey === 'review',
        count: reviewNeedsYou > 0 ? reviewNeedsYou : undefined,
      });
    }

    if (allowedTabs.has('files')) {
      accessItems.push({
        id: 'repo',
        label: 'Repo Files',
        href: capabilityTabHref(projectId, 'files'),
        icon: FolderIcon,
        isActive: activeTabKey === 'files',
      });
    }

    if (allowedTabs.has('reminders')) {
      accessItems.push({
        id: 'reminders',
        label: 'Reminders',
        href: capabilityTabHref(projectId, 'reminders'),
        icon: ClockAfternoonIcon,
        isActive: activeTabKey === 'reminders',
      });
    }

    const result: NavGroup[] = [
      { id: 'intelligence', title: 'Intelligence', items: intelligenceItems },
      { id: 'connectivity', title: 'Connectivity', items: connectivityItems },
      { id: 'settings', title: 'Project Settings', items: settingsItems },
    ];

    if (accessItems.length > 0 || showMembers) {
      result.push({ id: 'access', title: 'Access & Governance', items: accessItems });
    }

    return result;
  }, [
    projectId,
    activeTabKey,
    isSettingsActive,
    activeSectionKey,
    settingsSections,
    upgradeAttention,
    allowedTabs,
    reviewNeedsYou,
    showMembers,
  ]);

  return (
    <aside
      className={cn(
        'border-border min-h-0 w-60 shrink-0 flex-col border-r bg-background @2xl:flex',
        className,
      )}
    >
      {/* Titlebar Header */}
      <header
        className="kx-titlebar-row kx-capability-titlebar border-border relative flex h-10 shrink-0 items-center gap-1 border-b px-2"
        data-sidebar-collapsed={sidebar?.state === 'collapsed' || undefined}
      >
        <SidebarToggle />
        <div className="kx-titlebar-tabs flex h-10 min-w-0 flex-1 items-center gap-2 pl-2">
          <h1 className="text-foreground min-w-0 flex-1 truncate text-xs font-semibold">
            Customize
          </h1>
        </div>
      </header>

      {/* Nav groups */}
      <nav
        aria-label="Customize Navigation"
        className="min-h-0 flex-1 space-y-5 overflow-y-auto px-2 py-3 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
      >
        {groups.map((group) => (
          <div key={group.id} className="space-y-1">
            <div className="text-muted-foreground px-2.5 py-1 text-xs font-medium">
              {group.title}
            </div>
            <ul className="space-y-0.5">
              {group.items.map((item) => {
                const Icon = item.icon;
                return (
                  <li key={item.id}>
                    <Link
                      href={item.href}
                      prefetch={true}
                      className={cn(
                        'flex h-8 items-center gap-2.5 rounded-md px-2.5 text-xs font-medium transition-colors',
                        item.isActive
                          ? 'bg-active text-foreground font-medium'
                          : 'text-muted-foreground hover:bg-hover hover:text-foreground',
                      )}
                    >
                      <Icon
                        className={cn(
                          'size-4 shrink-0',
                          item.isActive ? 'text-foreground' : 'text-muted-foreground',
                        )}
                      />
                      <span className="min-w-0 flex-1 truncate">{item.label}</span>
                      {item.count ? (
                        <CountBadge count={item.count} className="ml-auto" />
                      ) : item.attention ? (
                        <span
                          aria-hidden
                          className="bg-kortix-orange size-1.5 shrink-0 rounded-full ml-auto"
                        />
                      ) : null}
                    </Link>
                  </li>
                );
              })}

              {/* Members link inside Access group */}
              {group.id === 'access' && showMembers ? (
                <li>
                  {accountId ? (
                    <HubLink
                      to={hubTarget(accountId, {
                        tab: 'access-projects',
                        project: projectId,
                      })}
                      className="text-muted-foreground hover:bg-hover hover:text-foreground flex h-8 items-center gap-2.5 rounded-md px-2.5 text-xs font-medium transition-colors"
                    >
                      <UsersIcon className="text-muted-foreground size-4 shrink-0" />
                      <span className="min-w-0 flex-1 truncate">Members & Roles</span>
                      <ArrowUpRightIcon className="size-3 shrink-0 opacity-60" />
                    </HubLink>
                  ) : (
                    <div className="text-muted-foreground flex h-8 items-center gap-2.5 px-2.5 text-xs">
                      <UsersIcon className="size-4 shrink-0" />
                      <span className="min-w-0 flex-1 truncate">Members & Roles</span>
                    </div>
                  )}
                </li>
              ) : null}
            </ul>
          </div>
        ))}
      </nav>
    </aside>
  );
}
