'use client';

import { useState, useMemo, useEffect } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  ArrowLeftIcon,
  RobotIcon,
  SparkleIcon,
  CpuIcon,
  PlugsConnectedIcon,
  LightningIcon,
  KeyIcon,
  GitBranchIcon,
  CubeIcon,
  FlaskIcon,
  UserIcon,
  ShieldCheckIcon,
  PaintBrushIcon,
  BellIcon,
  TranslateIcon,
  DesktopIcon,
  GearSixIcon,
  UsersIcon,
  CreditCardIcon,
  ScrollIcon,
  MagnifyingGlassIcon,
  CaretRightIcon,
  CaretDownIcon,
  CheckIcon,
} from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import { getProjectDetail } from '@kortix/sdk';
import { contract, qk } from '@kortix/sdk/react';
import { Badge } from '@kortix/ui/badge';
import { Button } from '@kortix/ui/button';
import { cn } from '@kortix/ui';
import { useAccountState } from '@kortix/ui/internal/billing/index';
import { useSettingsNav } from '@kortix/ui/internal/layout/settings-nav-context';
import { PROJECT_ACTIONS, useProjectCan } from '@kortix/ui/workspace';

// Personal Tabs
import { ProfileTab } from './tabs/profile-tab';
import { SecurityTab } from './tabs/security-tab';
import { AppearanceTab } from './tabs/appearance-tab';
import { SessionsTab } from './tabs/sessions-tab';
import { PreferencesTab } from './tabs/preferences-tab';
import { ConnectedAccountsTab } from './tabs/connected-tab';
import { McpTab } from './tabs/mcp-tab';
import { ComputerTab } from './tabs/computer-tab';
import { CreditsTab } from './tabs/credits-tab';
import { PlanTab } from './tabs/plan-tab';
import {
  AccountMembershipsSection,
  useAccountMemberships,
  DEFAULT_ACCOUNT_MEMBERSHIPS_COPY,
} from './tabs/account-memberships';
import { useSettingsAccountId } from './use-settings-account-id';

// Capabilities & Project Tabs
import {
  AgentsPage,
  SkillsPage,
  ConnectorsPage,
  TriggersPage,
  SecretsPage,
  ProjectSettingsPage,
  LlmSections,
  ProjectDefaultPicker,
  useStandaloneCapabilityNav,
  SettingsNavProvider,
} from '@kortix/ui/customize';
import { GeneralTab } from '@kortix/ui/customize/settings/tabs/general-tab';
import { SandboxTab } from '@kortix/ui/customize/settings/tabs/sandbox-tab';
import { SnapshotsTab } from '@kortix/ui/customize/settings/tabs/snapshots-tab';
import { ExperimentalTab } from '@kortix/ui/customize/settings/tabs/experimental-tab';
import { TokensTab } from '@kortix/ui/customize/settings/tabs/tokens-tab';

export type SettingsCategory = 'capabilities' | 'personal' | 'organization';

export type ModelSubTab =
  | 'providers'
  | 'models'
  | 'custom'
  | 'gateway'
  | 'routing'
  | 'overview'
  | 'logs';

interface NavItemDef {
  id: string;
  category: SettingsCategory;
  label: string;
  description: string;
  icon: typeof RobotIcon;
  badge?: string;
  subitems?: ReadonlyArray<{ id: string; label: string }>;
}

const NAV_ITEMS: readonly NavItemDef[] = [
  // Capabilities
  {
    id: 'agents',
    category: 'capabilities',
    label: 'Agents',
    description: 'Autonomous agent persona, rules, tool permissions & assignments',
    icon: RobotIcon,
  },
  {
    id: 'skills',
    category: 'capabilities',
    label: 'Skills',
    description: 'Repository skills catalog and custom capabilities',
    icon: SparkleIcon,
  },
  {
    id: 'models',
    category: 'capabilities',
    label: 'Models',
    description: 'Providers, lineups, custom models, gateway, routing, costs & logs',
    icon: CpuIcon,
    subitems: [
      { id: 'providers', label: 'Providers' },
      { id: 'models', label: 'Lineup' },
      { id: 'custom', label: 'Custom' },
      { id: 'gateway', label: 'Gateway' },
      { id: 'routing', label: 'Routing' },
      { id: 'overview', label: 'Costs & Budgets' },
      { id: 'logs', label: 'Logs' },
    ],
  },
  {
    id: 'connectors',
    category: 'capabilities',
    label: 'Connectors',
    description: 'Integrations with GitHub, Slack, Linear, Google Drive & Notion',
    icon: PlugsConnectedIcon,
  },
  {
    id: 'triggers',
    category: 'capabilities',
    label: 'Triggers',
    description: 'Scheduled jobs, webhooks, cron timers & event automations',
    icon: LightningIcon,
  },
  {
    id: 'secrets',
    category: 'capabilities',
    label: 'Secrets Vault',
    description: 'Project BYOK API keys, tokens & credentials',
    icon: KeyIcon,
  },
  {
    id: 'git',
    category: 'capabilities',
    label: 'Git Repository',
    description: 'Connected Git repository, branches & change request policies',
    icon: GitBranchIcon,
  },
  {
    id: 'sandbox',
    category: 'capabilities',
    label: 'Sandbox & Snapshots',
    description: 'Cloud Hypervisor microVM templates & filesystem snapshots',
    icon: CubeIcon,
  },
  {
    id: 'feature-flags',
    category: 'capabilities',
    label: 'Feature Flags',
    description: 'Beta capabilities and experimental platform toggles',
    icon: FlaskIcon,
  },

  // Personal Settings
  {
    id: 'profile',
    category: 'personal',
    label: 'Profile',
    description: 'User profile, avatar, email address & account management',
    icon: UserIcon,
  },
  {
    id: 'security',
    category: 'personal',
    label: 'Security',
    description: 'Two-factor authentication, backup codes & active signed-in devices',
    icon: ShieldCheckIcon,
  },
  {
    id: 'appearance',
    category: 'personal',
    label: 'Appearance',
    description: 'Interface theme, typography, density & visual modes',
    icon: PaintBrushIcon,
  },
  {
    id: 'notifications',
    category: 'personal',
    label: 'Notifications',
    description: 'Completion alerts, sound effects & messaging channels',
    icon: BellIcon,
  },
  {
    id: 'preferences',
    category: 'personal',
    label: 'Language & Shortcuts',
    description: 'Locale preferences, command palette & keyboard shortcuts',
    icon: TranslateIcon,
  },
  {
    id: 'tokens',
    category: 'personal',
    label: 'Personal Access Keys',
    description: 'Personal authentication tokens for CLI and external APIs',
    icon: KeyIcon,
  },
  {
    id: 'mcp',
    category: 'personal',
    label: 'MCP',
    description: 'Model Context Protocol endpoints & configuration',
    icon: CpuIcon,
  },
  {
    id: 'computer',
    category: 'personal',
    label: 'My Computer',
    description: 'Desktop computer control and local workspace pairing',
    icon: DesktopIcon,
  },

  // Organization Settings
  {
    id: 'general',
    category: 'organization',
    label: 'General',
    description: 'Organization identity, slug & default workspace policies',
    icon: GearSixIcon,
  },
  {
    id: 'members',
    category: 'organization',
    label: 'Members & Roles',
    description: 'Team directory, invitation management & role assignments',
    icon: UsersIcon,
  },
  {
    id: 'billing',
    category: 'organization',
    label: 'Billing & Credits',
    description: 'Plan tier, credit wallet, automatic refill & invoices',
    icon: CreditCardIcon,
  },
  {
    id: 'branding',
    category: 'organization',
    label: 'Branding',
    description: 'Custom logo, product branding & enterprise white-labeling',
    icon: PaintBrushIcon,
  },
  {
    id: 'audit',
    category: 'organization',
    label: 'Audit Logs',
    description: 'Security audit trail of user and agent actions',
    icon: ScrollIcon,
  },
];

export interface UnifiedSettingsPageProps {
  projectId: string;
  initialCategory?: SettingsCategory;
  initialTab?: string;
  initialModelSubTab?: ModelSubTab;
}

export function UnifiedSettingsPage({
  projectId,
  initialCategory = 'capabilities',
  initialTab = 'agents',
  initialModelSubTab = 'providers',
}: UnifiedSettingsPageProps) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const queryCategory = searchParams.get('category') as SettingsCategory | null;
  const queryTab = searchParams.get('tab');
  const querySubtab = searchParams.get('subtab') as ModelSubTab | null;

  const [category, setCategory] = useState<SettingsCategory>(
    queryCategory ?? initialCategory,
  );
  const [activeTab, setActiveTab] = useState<string>(queryTab ?? initialTab);
  const [modelSubTab, setModelSubTab] = useState<ModelSubTab>(
    querySubtab ?? initialModelSubTab,
  );
  const [search, setSearch] = useState('');
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(null);

  // Sync state from query parameters if URL changes externally
  useEffect(() => {
    if (queryCategory) setCategory(queryCategory);
    if (queryTab) setActiveTab(queryTab);
    if (querySubtab) setModelSubTab(querySubtab);
  }, [queryCategory, queryTab, querySubtab]);

  // Project Detail Query
  const detail = useQuery({
    queryKey: qk.project.detail(projectId),
    queryFn: () => getProjectDetail(projectId),
    enabled: !!projectId,
    ...contract('config'),
  });
  const project = detail.data?.project;
  const projectAccountId = project?.account_id;
  const accountId = useSettingsAccountId(projectAccountId);
  const { data: accountState } = useAccountState({ accountId });
  const { accounts: orgAccounts, isLoading: orgAccountsLoading } = useAccountMemberships();

  // Project Permissions
  const canWriteProject = useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_WRITE).allowed === true;

  // Settings Nav Provider state for capabilities requiring useSettingsNav()
  const settingsNav = useStandaloneCapabilityNav(projectId, activeTab);

  // Filtered Navigation Items
  const normalizedSearch = search.trim().toLowerCase();
  const visibleItems = useMemo(() => {
    if (normalizedSearch) {
      return NAV_ITEMS.filter(
        (item) =>
          item.label.toLowerCase().includes(normalizedSearch) ||
          item.description.toLowerCase().includes(normalizedSearch) ||
          item.subitems?.some((sub) => sub.label.toLowerCase().includes(normalizedSearch)),
      );
    }
    return NAV_ITEMS.filter((item) => item.category === category);
  }, [category, normalizedSearch]);

  const handleSelectTab = (item: NavItemDef, subtab?: ModelSubTab) => {
    setCategory(item.category);
    setActiveTab(item.id);
    if (subtab) {
      setModelSubTab(subtab);
    }
  };

  const planTier = accountState?.tier?.name ?? 'Free Plan';

  return (
    <SettingsNavProvider value={settingsNav}>
      <div className="bg-background text-foreground flex min-h-screen w-full flex-col">
        {/* ── Top Bar ── */}
        <header className="border-border/80 bg-background/95 sticky top-0 z-30 flex h-14 shrink-0 items-center justify-between border-b px-4 backdrop-blur-sm sm:px-8">
          <div className="flex items-center gap-4">
            <Link
              href={`/projects/${projectId}`}
              className="text-muted-foreground hover:text-foreground flex items-center gap-2 text-xs font-medium transition-colors"
            >
              <ArrowLeftIcon className="size-4 shrink-0" />
              <span>Back to Workspace</span>
            </Link>
          </div>

          {/* Category Switcher Pills */}
          <div className="bg-muted/70 flex h-9 items-center rounded-md p-1">
            <button
              type="button"
              onClick={() => {
                setCategory('capabilities');
                if (category !== 'capabilities') setActiveTab('agents');
              }}
              className={cn(
                'flex items-center gap-1.5 rounded-sm px-3 py-1 text-xs font-medium transition-colors',
                category === 'capabilities'
                  ? 'bg-background text-foreground shadow-xs'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <SparkleIcon className="size-3.5" />
              <span>Capabilities</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setCategory('personal');
                if (category !== 'personal') setActiveTab('profile');
              }}
              className={cn(
                'flex items-center gap-1.5 rounded-sm px-3 py-1 text-xs font-medium transition-colors',
                category === 'personal'
                  ? 'bg-background text-foreground shadow-xs'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <UserIcon className="size-3.5" />
              <span>Personal</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setCategory('organization');
                if (category !== 'organization') setActiveTab('general');
              }}
              className={cn(
                'flex items-center gap-1.5 rounded-sm px-3 py-1 text-xs font-medium transition-colors',
                category === 'organization'
                  ? 'bg-background text-foreground shadow-xs'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <GearSixIcon className="size-3.5" />
              <span>Organization</span>
            </button>
          </div>

          {/* Account / Plan Status */}
          <div className="flex items-center gap-2.5">
            <Badge variant="secondary" size="xs">
              {planTier}
            </Badge>
            <span className="text-muted-foreground hidden font-mono text-[11px] sm:inline-block">
              {project?.name ?? 'Dosco'}
            </span>
          </div>
        </header>

        {/* ── Main Layout: Sticky Sidebar Rail + Content Canvas ── */}
        <div className="mx-auto flex w-full max-w-7xl flex-1 items-start gap-8 px-4 sm:px-8">
          {/* ── Left Rail: Sticky Submenu Navigator ── */}
          <aside className="border-border/80 sticky top-14 hidden h-[calc(100vh-3.5rem)] w-64 shrink-0 flex-col border-r py-6 pr-4 md:flex">
            {/* Search Settings Input */}
            <div className="relative mb-4 flex items-center">
              <MagnifyingGlassIcon className="text-muted-foreground pointer-events-none absolute left-2.5 size-3.5" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search settings..."
                className="bg-popover border-border/80 text-foreground placeholder:text-muted-foreground w-full rounded-md border py-1.5 pr-2 pl-7 text-xs focus:outline-hidden focus:ring-1 focus:ring-ring"
              />
            </div>

            {/* Scrollable Navigation List */}
            <nav className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
              {visibleItems.length === 0 ? (
                <p className="text-muted-foreground py-4 text-center text-xs">
                  No matching settings found
                </p>
              ) : (
                visibleItems.map((item) => {
                  const isActive = activeTab === item.id;
                  const Icon = item.icon;
                  const hasSubitems = item.subitems && item.subitems.length > 0;

                  return (
                    <div key={item.id} className="flex flex-col">
                      <button
                        type="button"
                        onClick={() => handleSelectTab(item)}
                        className={cn(
                          'flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors',
                          isActive
                            ? 'bg-muted text-foreground font-semibold'
                            : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground',
                        )}
                      >
                        <div className="flex items-center gap-2 truncate">
                          <Icon className="size-4 shrink-0" />
                          <span className="truncate">{item.label}</span>
                        </div>
                        {hasSubitems ? (
                          isActive ? (
                            <CaretDownIcon className="size-3 shrink-0" />
                          ) : (
                            <CaretRightIcon className="text-muted-foreground size-3 shrink-0" />
                          )
                        ) : null}
                      </button>

                      {/* Expandable Submenus (e.g. Models) */}
                      {hasSubitems && isActive && (
                        <div className="border-border/60 ml-4 mt-1 flex flex-col gap-0.5 border-l pl-2">
                          {item.subitems!.map((sub) => {
                            const isSubActive = modelSubTab === sub.id;
                            return (
                              <button
                                key={sub.id}
                                type="button"
                                onClick={() => handleSelectTab(item, sub.id as ModelSubTab)}
                                className={cn(
                                  'flex items-center rounded-md px-2 py-1 text-xs transition-colors',
                                  isSubActive
                                    ? 'bg-muted/80 text-foreground font-semibold'
                                    : 'text-muted-foreground hover:bg-muted/40 hover:text-foreground',
                                )}
                              >
                                <span>{sub.label}</span>
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </nav>

            {/* Compact Account Footer */}
            <div className="border-border/80 bg-muted/20 mt-4 flex items-center justify-between rounded-md border p-2.5">
              <div className="flex min-w-0 items-center gap-2">
                <div className="bg-muted flex size-7 shrink-0 items-center justify-center rounded-full">
                  <UserIcon className="text-foreground size-3.5" />
                </div>
                <div className="min-w-0 truncate">
                  <div className="text-foreground truncate text-xs font-medium">
                    {project?.name ?? 'Dosco Workspace'}
                  </div>
                  <div className="text-muted-foreground truncate text-[11px] font-mono">
                    {projectId}
                  </div>
                </div>
              </div>
              <Badge variant="outline" size="xs">
                {planTier}
              </Badge>
            </div>
          </aside>

          {/* ── Right Canvas: Main Active Setting Pane ── */}
          <main className="min-w-0 flex-1 py-8">
            {/* 1. Capabilities Tab Views */}
            {activeTab === 'agents' && <AgentsPage projectId={projectId} />}
            {activeTab === 'skills' && <SkillsPage projectId={projectId} />}

            {/* Models: Single-tier view controlled via side rail submenus */}
            {activeTab === 'models' && (
              <div className="space-y-6">
                <div className="flex flex-col gap-2 border-b border-border/80 pb-4 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <h2 className="text-foreground text-lg font-semibold tracking-tight">
                      Models & Providers
                    </h2>
                    <p className="text-muted-foreground text-xs">
                      Configure LLM providers, model lineup, gateway routing, and spend limits.
                    </p>
                  </div>
                  <ProjectDefaultPicker projectId={projectId} />
                </div>

                <LlmSections
                  projectId={projectId}
                  tab={modelSubTab}
                  onTabChange={(nextTab) => setModelSubTab(nextTab as ModelSubTab)}
                  canWrite={canWriteProject}
                  enabled={true}
                  selectedProviderId={selectedProviderId}
                  onSelectProvider={setSelectedProviderId}
                  providersVariant="split"
                />
              </div>
            )}

            {activeTab === 'connectors' && <ConnectorsPage projectId={projectId} />}
            {activeTab === 'triggers' && <TriggersPage projectId={projectId} />}
            {activeTab === 'secrets' && <SecretsPage projectId={projectId} />}
            {activeTab === 'git' && <ProjectSettingsPage projectId={projectId} />}
            {activeTab === 'sandbox' && (
              <div className="space-y-8">
                <SandboxTab projectId={projectId} />
                <SnapshotsTab projectId={projectId} />
              </div>
            )}
            {activeTab === 'feature-flags' && <ExperimentalTab projectId={projectId} />}

            {/* 2. Personal Tab Views */}
            {activeTab === 'profile' && <ProfileTab />}
            {activeTab === 'security' && <SecurityTab />}
            {activeTab === 'appearance' && <AppearanceTab />}
            {activeTab === 'notifications' && <SessionsTab projectId={projectId} />}
            {activeTab === 'preferences' && <PreferencesTab />}
            {activeTab === 'tokens' && <TokensTab accountId={accountId} />}
            {activeTab === 'mcp' && <McpTab />}
            {activeTab === 'computer' && <ComputerTab projectId={projectId} />}

            {/* 3. Organization Tab Views */}
            {activeTab === 'general' && <GeneralTab projectId={projectId} />}
            {activeTab === 'members' && (
              <div className="space-y-6">
                <AccountMembershipsSection
                  accounts={orgAccounts}
                  isLoading={orgAccountsLoading}
                  copy={DEFAULT_ACCOUNT_MEMBERSHIPS_COPY}
                />
              </div>
            )}
            {activeTab === 'billing' && (
              <div className="space-y-8">
                <PlanTab accountId={accountId} />
                <CreditsTab accountId={accountId} />
              </div>
            )}
            {activeTab === 'branding' && (
              <div className="space-y-4">
                <div>
                  <h3 className="text-foreground text-sm font-semibold">Enterprise Branding</h3>
                  <p className="text-muted-foreground text-xs">
                    Custom themes, brand colors, and workspace white-labeling.
                  </p>
                </div>
                <div className="bg-popover border-border/80 rounded-md border p-6 text-center">
                  <p className="text-muted-foreground text-xs">
                    Available on Platinum and Enterprise subscriptions. Contact support to customize domain and brand assets.
                  </p>
                </div>
              </div>
            )}
            {activeTab === 'audit' && (
              <div className="space-y-4">
                <div>
                  <h3 className="text-foreground text-sm font-semibold">Security Audit Log</h3>
                  <p className="text-muted-foreground text-xs">
                    All administrative operations, logins, secret access, and agent sessions.
                  </p>
                </div>
                <div className="bg-popover border-border/80 rounded-md border p-6 text-center">
                  <p className="text-muted-foreground text-xs">
                    Organization audit logs are streamed to your configured SIEM or viewable by account administrators.
                  </p>
                </div>
              </div>
            )}
          </main>
        </div>
      </div>
    </SettingsNavProvider>
  );
}
