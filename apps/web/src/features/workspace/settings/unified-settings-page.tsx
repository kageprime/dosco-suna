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
  CoinsIcon,
  FingerprintIcon,
  FolderOpenIcon,
  ShieldIcon,
  FileTextIcon,
  WrenchIcon,
  BookOpenTextIcon,
  MagnifyingGlassIcon,
  CaretRightIcon,
  CaretDownIcon,
  SlidersHorizontalIcon,
} from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import { getProjectDetail } from '@kortix/sdk';
import { contract, qk } from '@kortix/sdk/react';
import { capitalizeWords } from '@kortix/shared';
import { Badge } from '@kortix/ui/badge';
import { Button } from '@kortix/ui/button';
import { cn } from '@kortix/ui';
import { AgentMark } from '@kortix/ui/internal/components/agent-mark';
import { useAccountState } from '@kortix/ui/internal/billing/index';
import { useSettingsNav } from '@kortix/ui/internal/layout/settings-nav-context';
import { PROJECT_ACTIONS, useProjectCan } from '@kortix/ui/workspace';
import { BillingAccountProvider } from '@kortix/ui/internal/stores/billing-account-context';
import { AccountHubSheetProvider } from '@kortix/ui/internal/account-hub/hub-sheet';

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
import { AgentPage } from '@kortix/ui/customize/agents/agent-page';
import type { AgentConfigSectionKey } from '@kortix/ui/customize/sections/view/agent-editor';
import { GeneralTab } from '@kortix/ui/customize/settings/tabs/general-tab';
import { SandboxTab } from '@kortix/ui/customize/settings/tabs/sandbox-tab';
import { SnapshotsTab } from '@kortix/ui/customize/settings/tabs/snapshots-tab';
import { ExperimentalTab } from '@kortix/ui/customize/settings/tabs/experimental-tab';
import { TokensTab } from '@kortix/ui/customize/settings/tabs/tokens-tab';

// Account Hub for Organization settings
import { AccountHubContent } from '@/features/accounts/hub/account-hub-content';

export type SettingsCategory = 'capabilities' | 'personal' | 'organization';

export type ModelSubTab =
  | 'providers'
  | 'models'
  | 'custom'
  | 'gateway'
  | 'routing'
  | 'overview'
  | 'logs';

export type OrgSubTab =
  | 'settings'
  | 'branding'
  | 'git'
  | 'tokens'
  | 'members'
  | 'groups'
  | 'access-projects'
  | 'roles'
  | 'identity'
  | 'audit'
  | 'billing'
  | 'transactions';

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

  // Organization Settings (Full Account Hub Mapping)
  {
    id: 'settings',
    category: 'organization',
    label: 'General',
    description: 'Organization identity, slug & default workspace policies',
    icon: GearSixIcon,
  },
  {
    id: 'branding',
    category: 'organization',
    label: 'Branding',
    description: 'Custom logo, product branding & enterprise white-labeling',
    icon: PaintBrushIcon,
  },
  {
    id: 'git',
    category: 'organization',
    label: 'Git Integration',
    description: 'Account-wide GitHub connections and managed Git policies',
    icon: GitBranchIcon,
  },
  {
    id: 'tokens',
    category: 'organization',
    label: 'Service API Keys',
    description: 'Machine identities and automation tokens for CI/CD runners',
    icon: KeyIcon,
  },
  {
    id: 'members',
    category: 'organization',
    label: 'Members & Roles',
    description: 'Team directory, invitation management & role assignments',
    icon: UsersIcon,
  },
  {
    id: 'groups',
    category: 'organization',
    label: 'User Groups',
    description: 'Permission pools and group access management',
    icon: UsersIcon,
  },
  {
    id: 'access-projects',
    category: 'organization',
    label: 'Projects Access',
    description: 'Project grants and access control matrix',
    icon: FolderOpenIcon,
  },
  {
    id: 'roles',
    category: 'organization',
    label: 'Custom Roles',
    description: 'Enterprise custom roles and granular IAM permissions',
    icon: ShieldIcon,
  },
  {
    id: 'identity',
    category: 'organization',
    label: 'Identity & SSO',
    description: 'SAML 2.0 Single Sign-On and SCIM directory sync',
    icon: FingerprintIcon,
  },
  {
    id: 'audit',
    category: 'organization',
    label: 'Audit Log',
    description: 'Security audit trail of user, API, and agent actions',
    icon: ScrollIcon,
  },
  {
    id: 'billing',
    category: 'organization',
    label: 'Plan & Billing',
    description: 'Subscription tier, credit wallet and payment methods',
    icon: CreditCardIcon,
  },
  {
    id: 'transactions',
    category: 'organization',
    label: 'Usage & Credits',
    description: 'Credit consumption ledger and spend breakdown',
    icon: CoinsIcon,
  },
];

const AGENT_SUB_SECTIONS: ReadonlyArray<{
  id: AgentConfigSectionKey;
  label: string;
  icon: typeof FileTextIcon;
}> = [
  { id: 'overview', label: 'Overview & Prompt', icon: FileTextIcon },
  { id: 'model', label: 'Model & Lineup', icon: CpuIcon },
  { id: 'tools', label: 'Tools & Permissions', icon: WrenchIcon },
  { id: 'skills', label: 'Skills', icon: BookOpenTextIcon },
  { id: 'connectors', label: 'Connectors', icon: PlugsConnectedIcon },
  { id: 'triggers', label: 'Triggers', icon: LightningIcon },
  { id: 'secrets', label: 'Secrets Vault', icon: KeyIcon },
  { id: 'people', label: 'People & Access', icon: UsersIcon },
  { id: 'workspace', label: 'Workspace', icon: CubeIcon },
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
  const queryAccountTab = searchParams.get('accountTab');
  const queryTab = searchParams.get('tab') || queryAccountTab;
  const queryAccountId = searchParams.get('accountId');
  const querySubtab = searchParams.get('subtab') as ModelSubTab | null;
  const queryAgent = searchParams.get('agent');
  const querySection = searchParams.get('section') as AgentConfigSectionKey | null;

  const isOrgTab = Boolean(
    queryAccountTab ||
    (queryTab && NAV_ITEMS.some((i) => i.id === queryTab && i.category === 'organization')) ||
    queryAccountId,
  );

  const initialResolvedCategory: SettingsCategory =
    queryCategory ?? (isOrgTab ? 'organization' : initialCategory);
  const initialResolvedTab: string =
    queryTab ?? (initialResolvedCategory === 'organization' ? 'settings' : initialTab);

  const [category, setCategory] = useState<SettingsCategory>(initialResolvedCategory);
  const [activeTab, setActiveTab] = useState<string>(initialResolvedTab);
  const [modelSubTab, setModelSubTab] = useState<ModelSubTab>(
    querySubtab ?? initialModelSubTab,
  );
  const [selectedAgent, setSelectedAgent] = useState<string | null>(queryAgent ?? null);
  const [agentSection, setAgentSection] = useState<AgentConfigSectionKey>(
    querySection ?? 'overview',
  );
  const [search, setSearch] = useState('');
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(null);

  // Sync state from query parameters if URL changes externally
  useEffect(() => {
    if (queryCategory) setCategory(queryCategory);
    if (queryTab) setActiveTab(queryTab);
    if (querySubtab) setModelSubTab(querySubtab);
    if (queryAgent !== undefined) setSelectedAgent(queryAgent);
    if (querySection) setAgentSection(querySection);
  }, [queryCategory, queryTab, querySubtab, queryAgent, querySection]);

  // Project Detail Query
  const detail = useQuery({
    queryKey: qk.project.detail(projectId),
    queryFn: () => getProjectDetail(projectId),
    enabled: !!projectId,
    ...contract('config'),
  });
  const project = detail.data?.project;
  const config = detail.data?.config;
  const projectAccountId = project?.account_id;
  const fallbackAccountId = useSettingsAccountId(projectAccountId);
  const accountId = queryAccountId || fallbackAccountId;
  const { data: accountState } = useAccountState({ accountId });

  // Project Permissions
  const canWriteProject = useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_WRITE).allowed === true;

  // Settings Nav Provider state for capabilities requiring useSettingsNav()
  const settingsNav = useStandaloneCapabilityNav(projectId, activeTab);

  // Available nav items for current category
  const categoryItems = useMemo(() => {
    return NAV_ITEMS.filter((item) => item.category === category);
  }, [category]);

  const handleSelectCategory = (nextCategory: SettingsCategory) => {
    setCategory(nextCategory);
    setSelectedAgent(null);
    let targetTab = 'agents';
    if (nextCategory === 'capabilities') {
      targetTab = 'agents';
    } else if (nextCategory === 'personal') {
      targetTab = 'profile';
    } else if (nextCategory === 'organization') {
      targetTab = 'settings';
    }
    setActiveTab(targetTab);
    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href);
      url.searchParams.set('category', nextCategory);
      if (nextCategory === 'organization') {
        url.searchParams.set('accountTab', targetTab);
        if (accountId) url.searchParams.set('accountId', accountId);
      } else {
        url.searchParams.set('tab', targetTab);
        url.searchParams.delete('accountTab');
      }
      window.history.replaceState(null, '', `${url.pathname}${url.search}`);
    }
  };

  const handleSelectTab = (itemId: string, subtab?: ModelSubTab) => {
    setActiveTab(itemId);
    if (itemId !== 'agents') {
      setSelectedAgent(null);
    }
    if (subtab) {
      setModelSubTab(subtab);
    }
    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href);
      url.searchParams.set('category', category);
      if (category === 'organization') {
        url.searchParams.set('accountTab', itemId);
        if (accountId) url.searchParams.set('accountId', accountId);
        url.searchParams.delete('tab');
      } else {
        url.searchParams.set('tab', itemId);
        url.searchParams.delete('accountTab');
      }
      window.history.replaceState(null, '', `${url.pathname}${url.search}`);
    }
  };

  const planTier = accountState?.tier?.name ?? 'Enterprise';

  return (
    <SettingsNavProvider value={settingsNav}>
      <div className="bg-background text-foreground flex h-dvh w-full flex-col overflow-hidden">
        {/* ── Top Bar ── */}
        <header className="border-border/80 bg-background/95 flex h-14 w-full shrink-0 items-center justify-between border-b px-6 backdrop-blur-sm">
          <div className="flex items-center gap-4">
            <Link
              href={`/projects/${projectId}`}
              className="text-foreground/80 hover:text-foreground flex items-center gap-2 text-sm font-medium transition-colors"
            >
              <ArrowLeftIcon className="size-4 shrink-0" />
              <span>Back to Workspace</span>
            </Link>
          </div>

          {/* Category Switcher Pills */}
          <div className="bg-muted/70 flex h-9 items-center rounded-md p-1">
            <button
              type="button"
              onClick={() => handleSelectCategory('capabilities')}
              className={cn(
                'flex items-center gap-1.5 rounded-sm px-3.5 py-1 text-sm font-medium transition-colors cursor-pointer',
                category === 'capabilities'
                  ? 'bg-background text-foreground shadow-xs font-semibold'
                  : 'text-foreground/70 hover:text-foreground',
              )}
            >
              <SparkleIcon className="size-4" />
              <span>Capabilities</span>
            </button>
            <button
              type="button"
              onClick={() => handleSelectCategory('personal')}
              className={cn(
                'flex items-center gap-1.5 rounded-sm px-3.5 py-1 text-sm font-medium transition-colors cursor-pointer',
                category === 'personal'
                  ? 'bg-background text-foreground shadow-xs font-semibold'
                  : 'text-foreground/70 hover:text-foreground',
              )}
            >
              <UserIcon className="size-4" />
              <span>Personal</span>
            </button>
            <button
              type="button"
              onClick={() => handleSelectCategory('organization')}
              className={cn(
                'flex items-center gap-1.5 rounded-sm px-3.5 py-1 text-sm font-medium transition-colors cursor-pointer',
                category === 'organization'
                  ? 'bg-background text-foreground shadow-xs font-semibold'
                  : 'text-foreground/70 hover:text-foreground',
              )}
            >
              <GearSixIcon className="size-4" />
              <span>Organization</span>
            </button>
          </div>

          {/* Account / Plan Status */}
          <div className="flex items-center gap-2.5">
            <Badge variant="secondary" size="xs">
              {planTier}
            </Badge>
            <span className="text-foreground font-mono text-xs font-medium hidden sm:inline-block">
              {project?.name ?? 'Bright Willow'}
            </span>
          </div>
        </header>

        {/* ── Main Layout: Full Bleed Shell (No Clamping) ── */}
        <div className="flex w-full flex-1 min-h-0 overflow-hidden">
          {/* ── Settings Sidebar Navigation (Generous Room, High-Contrast Typography) ── */}
          <aside className="border-border/80 bg-background/50 hidden h-full w-60 shrink-0 flex-col border-r md:flex overflow-hidden">
            <div className="p-4 border-b border-border/60 flex items-center justify-between">
              <span className="text-sm font-semibold text-foreground tracking-tight">
                {selectedAgent && activeTab === 'agents'
                  ? 'Agent Configuration'
                  : category === 'project'
                    ? 'Project Settings'
                    : category === 'capabilities'
                      ? 'Capabilities'
                      : 'Organization'}
              </span>
            </div>

            <div className="flex-1 overflow-y-auto p-3 space-y-1">
              {/* Special Submenu: Selected Agent */}
              {activeTab === 'agents' && selectedAgent ? (
                <div className="space-y-3">
                  <button
                    type="button"
                    onClick={() => setSelectedAgent(null)}
                    className="flex items-center gap-1.5 text-xs text-foreground/80 hover:text-foreground font-medium px-2.5 py-1.5 rounded-md hover:bg-muted/60 transition-colors w-full cursor-pointer"
                  >
                    <ArrowLeftIcon className="size-3.5 shrink-0" />
                    <span>Back to all agents</span>
                  </button>

                  <div className="flex items-center gap-2.5 px-3 py-2 bg-muted/40 rounded-lg border border-border/60">
                    <AgentMark slug={selectedAgent} />
                    <div className="min-w-0 flex-1 truncate">
                      <p className="text-sm font-semibold text-foreground truncate">
                        {capitalizeWords(selectedAgent)}
                      </p>
                    </div>
                  </div>

                  <div className="pt-2 space-y-0.5 border-t border-border/50">
                    {AGENT_SUB_SECTIONS.map((sec) => {
                      const isSecActive = agentSection === sec.id;
                      const SecIcon = sec.icon;

                      return (
                        <button
                          key={sec.id}
                          type="button"
                          onClick={() => setAgentSection(sec.id)}
                          className={cn(
                            'flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium transition-colors cursor-pointer',
                            isSecActive
                              ? 'bg-muted text-foreground font-semibold shadow-2xs'
                              : 'text-foreground/80 hover:bg-muted/40 hover:text-foreground',
                          )}
                        >
                          <SecIcon className="size-4 shrink-0 text-foreground" />
                          <span className="truncate">{sec.label}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ) : activeTab === 'models' ? (
                /* Submenu for Models */
                <div className="space-y-0.5">
                  {[
                    { id: 'providers', label: 'Providers' },
                    { id: 'models', label: 'Model Lineup' },
                    { id: 'custom', label: 'Custom Models' },
                    { id: 'gateway', label: 'Gateway' },
                    { id: 'routing', label: 'Routing Policies' },
                    { id: 'overview', label: 'Costs & Budgets' },
                    { id: 'logs', label: 'Gateway Logs' },
                  ].map((sub) => {
                    const isSubActive = modelSubTab === sub.id;
                    return (
                      <button
                        key={sub.id}
                        type="button"
                        onClick={() => setModelSubTab(sub.id as ModelSubTab)}
                        className={cn(
                          'flex w-full items-center rounded-md px-3 py-2 text-sm font-medium transition-colors cursor-pointer',
                          isSubActive
                            ? 'bg-muted text-foreground font-semibold shadow-2xs'
                            : 'text-foreground/80 hover:bg-muted/40 hover:text-foreground',
                        )}
                      >
                        <span className="truncate">{sub.label}</span>
                      </button>
                    );
                  })}
                </div>
              ) : (
                /* Default List of Sections in Category */
                <div className="space-y-0.5">
                  {categoryItems.map((item) => {
                    const isActive = activeTab === item.id;
                    const Icon = item.icon;

                    return (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => handleSelectTab(item.id)}
                        className={cn(
                          'flex w-full items-center justify-between rounded-md px-3 py-2 text-sm font-medium transition-colors cursor-pointer',
                          isActive
                            ? 'bg-muted text-foreground font-semibold shadow-2xs'
                            : 'text-foreground/80 hover:bg-muted/40 hover:text-foreground',
                        )}
                      >
                        <div className="flex items-center gap-2.5 truncate">
                          <Icon className="size-4 shrink-0 text-foreground" />
                          <span className="truncate">{item.label}</span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </aside>

          {/* ── 3. Main Content Canvas (Scrollbar at Far Right Edge) ── */}
          <main className="min-w-0 flex-1 h-full overflow-y-auto bg-background">
            <div className="max-w-4xl mx-auto py-8 px-6 sm:px-10 pb-32">
              {/* 1. Capabilities Tab Views */}
              {activeTab === 'agents' && (
                selectedAgent ? (
                  <AgentPage
                    projectId={projectId}
                    agentName={selectedAgent}
                    hideNav={true}
                    activeSection={agentSection}
                    onSectionChange={setAgentSection}
                    onBack={() => setSelectedAgent(null)}
                  />
                ) : (
                  <AgentsPage
                    projectId={projectId}
                    onSelectAgent={(name) => setSelectedAgent(name)}
                  />
                )
              )}

              {activeTab === 'skills' && <SkillsPage projectId={projectId} />}

              {/* Models View */}
              {activeTab === 'models' && (
                <div className="space-y-6">
                  <div className="flex flex-col gap-2 border-b border-border/80 pb-4 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <h2 className="text-foreground text-lg font-semibold tracking-tight">
                        Models & Providers
                      </h2>
                      <p className="text-muted-foreground text-sm">
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
              {activeTab === 'git' && category === 'capabilities' && (
                <ProjectSettingsPage projectId={projectId} />
              )}
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
              {activeTab === 'tokens' && category === 'personal' && (
                <TokensTab accountId={accountId} />
              )}
              {activeTab === 'mcp' && <McpTab />}
              {activeTab === 'computer' && <ComputerTab projectId={projectId} />}

              {/* 3. Organization Tab Views (Full Account Hub Engine) */}
              {category === 'organization' && (
                <BillingAccountProvider accountId={accountId}>
                  <AccountHubSheetProvider>
                    <AccountHubContent
                      accountId={accountId}
                      section={activeTab as any}
                    />
                  </AccountHubSheetProvider>
                </BillingAccountProvider>
              )}
            </div>
          </main>
        </div>
      </div>
    </SettingsNavProvider>
  );
}