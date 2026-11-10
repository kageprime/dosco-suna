'use client';

import { useState, useMemo, useEffect } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
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
  CaretUpDownIcon,
  CaretDownIcon,
  SlidersHorizontalIcon,
  TimerIcon,
  TreeStructureIcon,
  CommandIcon,
  PuzzlePieceIcon,
  GlobeIcon,
  HardDriveIcon,
  TerminalWindowIcon,
  CheckIcon,
  HardDrivesIcon,
  TrayIcon,
} from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import { getProjectDetail } from '@kortix/sdk';
import { contract, qk, useFeatureFlag } from '@kortix/sdk/react';
import { capitalizeWords } from '@kortix/shared';
import { Badge } from '@kortix/ui/badge';
import { CountBadge } from '@kortix/ui/count-badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@kortix/ui/dropdown-menu';
import { EntityAvatar } from '@kortix/ui/entity-avatar';
import {
  InputGroupSearch,
  InputGroupSearchClear,
  InputGroupSearchIcon,
  InputGroupSearchInput,
} from '@kortix/ui/input-group';
import { Tabs, TabsList, TabsTrigger } from '@kortix/ui/tabs';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@kortix/ui/sheet';
import { cn } from '@kortix/ui';
import { AgentMark, agentDisplayName } from '@kortix/ui/internal/components/agent-mark';
import { useAccountState } from '@kortix/ui/internal/billing/index';
import type { SettingsNav } from '@kortix/ui/internal/layout/settings-nav-context';
import { PROJECT_ACTIONS, useProjectCan } from '@kortix/ui/workspace';
import { BillingAccountProvider } from '@kortix/ui/internal/stores/billing-account-context';
import { AccountHubSheetProvider } from '@kortix/ui/internal/account-hub/hub-sheet';
import { EmbeddedAccountHubProvider } from '@kortix/ui/internal/account-hub/account-hub-location';
import { useSettingsPanelStore, type MembersTab } from '@kortix/ui/internal/stores/settings-panel-store';

// Personal Tabs
import { ProfileTab } from './tabs/profile-tab';
import { SecurityTab } from './tabs/security-tab';
import { AppearanceTab } from './tabs/appearance-tab';
import { SessionsTab } from './tabs/sessions-tab';
import { PreferencesTab } from './tabs/preferences-tab';
import { McpTab } from './tabs/mcp-tab';
import { ComputerTab } from './tabs/computer-tab';
import { useSettingsAccountId } from './use-settings-account-id';

// Capabilities & Project Tabs
import {
  AgentsPage,
  SkillsPage,
  ToolsPage,
  ExtensionsPage,
  AgentDrivesSection,
  ReviewPage,
  ConnectorsPage,
  TriggersPage,
  SecretsPage,
  GitView,
  LlmSections,
  ProjectDefaultPicker,
  SettingsNavProvider,
  type AgentConfigSectionGroup,
  type AgentConfigSectionKey,
} from '@kortix/ui/customize';
import { AgentPage } from '@kortix/ui/customize/agents/agent-page';
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
  group: string;
  label: string;
  description: string;
  icon: typeof RobotIcon;
  drilldown?: boolean;
}

const NAV_ITEMS: readonly NavItemDef[] = [
  // Capabilities — Intelligence
  {
    id: 'agents',
    category: 'capabilities',
    group: 'Intelligence',
    label: 'Agents',
    description: 'Autonomous agent persona, rules, tool permissions & assignments',
    icon: RobotIcon,
  },
  {
    id: 'skills',
    category: 'capabilities',
    group: 'Intelligence',
    label: 'Skills',
    description: 'Repository skills catalog and custom capabilities',
    icon: SparkleIcon,
  },
  {
    id: 'tools',
    category: 'capabilities',
    group: 'Intelligence',
    label: 'Tools',
    description: 'Custom tools, CLI scripts, and MCP tool integrations',
    icon: WrenchIcon,
  },
  {
    id: 'models',
    category: 'capabilities',
    group: 'Intelligence',
    label: 'Models',
    description: 'Providers, lineups, custom models, gateway, routing, costs & logs',
    icon: CpuIcon,
    drilldown: true,
  },
  {
    id: 'review',
    category: 'capabilities',
    group: 'Intelligence',
    label: 'Review',
    description: 'Agent approvals, human-in-the-loop decisions & change requests',
    icon: TrayIcon,
  },

  // Capabilities — Connectivity & Secrets
  {
    id: 'connectors',
    category: 'capabilities',
    group: 'Connectivity',
    label: 'Connectors',
    description: 'Integrations with GitHub, Slack, Linear, Google Drive & Notion',
    icon: PlugsConnectedIcon,
  },
  {
    id: 'extensions',
    category: 'capabilities',
    group: 'Connectivity',
    label: 'Extensions',
    description: 'Runtime extensions and external platform plugins',
    icon: PuzzlePieceIcon,
  },
  {
    id: 'triggers',
    category: 'capabilities',
    group: 'Connectivity',
    label: 'Triggers',
    description: 'Scheduled jobs, webhooks, cron timers & event automations',
    icon: LightningIcon,
  },
  {
    id: 'secrets',
    category: 'capabilities',
    group: 'Connectivity',
    label: 'Secrets',
    description: 'Project API keys, tokens & credentials',
    icon: KeyIcon,
  },

  // Capabilities — Project & Runtime
  {
    id: 'general',
    category: 'capabilities',
    group: 'Project & Runtime',
    label: 'General',
    description: 'Workspace name, icon, description & project lifecycle',
    icon: SlidersHorizontalIcon,
  },
  {
    id: 'git',
    category: 'capabilities',
    group: 'Project & Runtime',
    label: 'Git',
    description: 'Repository configuration, branches, clone URL & collaborators',
    icon: GitBranchIcon,
  },
  {
    id: 'drives',
    category: 'capabilities',
    group: 'Project & Runtime',
    label: 'Drives',
    description: 'Workspace storage drives, mounts & shared folders',
    icon: HardDrivesIcon,
  },
  {
    id: 'sandbox',
    category: 'capabilities',
    group: 'Project & Runtime',
    label: 'Sandbox & Snapshots',
    description: 'Cloud Hypervisor microVM templates & filesystem snapshots',
    icon: CubeIcon,
  },
  {
    id: 'members',
    category: 'capabilities',
    group: 'Project & Runtime',
    label: 'Members',
    description: 'Project collaborators, roles & member permissions',
    icon: UsersIcon,
  },
  {
    id: 'feature-flags',
    category: 'capabilities',
    group: 'Project & Runtime',
    label: 'Feature Flags',
    description: 'Beta capabilities and experimental platform toggles',
    icon: FlaskIcon,
  },

  // Personal Settings — Identity & Access
  {
    id: 'profile',
    category: 'personal',
    group: 'Identity & Access',
    label: 'Profile',
    description: 'User profile, avatar, email address & account management',
    icon: UserIcon,
  },
  {
    id: 'security',
    category: 'personal',
    group: 'Identity & Access',
    label: 'Security',
    description: 'Two-factor authentication, backup codes & active signed-in devices',
    icon: ShieldCheckIcon,
  },
  {
    id: 'tokens',
    category: 'personal',
    group: 'Identity & Access',
    label: 'Personal Access Keys',
    description: 'Personal authentication tokens for CLI and external APIs',
    icon: KeyIcon,
  },

  // Personal Settings — Workspace Experience
  {
    id: 'appearance',
    category: 'personal',
    group: 'Experience',
    label: 'Appearance',
    description: 'Interface theme, typography, density & visual modes',
    icon: PaintBrushIcon,
  },
  {
    id: 'notifications',
    category: 'personal',
    group: 'Experience',
    label: 'Notifications',
    description: 'Completion alerts, sound effects & messaging channels',
    icon: BellIcon,
  },
  {
    id: 'preferences',
    category: 'personal',
    group: 'Experience',
    label: 'Language & Shortcuts',
    description: 'Locale preferences, command palette & keyboard shortcuts',
    icon: TranslateIcon,
  },

  // Personal Settings — Local Runtime
  {
    id: 'mcp',
    category: 'personal',
    group: 'Local Runtime',
    label: 'MCP',
    description: 'Model Context Protocol endpoints & configuration',
    icon: CpuIcon,
  },
  {
    id: 'computer',
    category: 'personal',
    group: 'Local Runtime',
    label: 'My Computer',
    description: 'Desktop computer control and local workspace pairing',
    icon: DesktopIcon,
  },

  // Organization Settings — General
  {
    id: 'settings',
    category: 'organization',
    group: 'Organization',
    label: 'General',
    description: 'Organization identity, slug & default workspace policies',
    icon: GearSixIcon,
  },
  {
    id: 'branding',
    category: 'organization',
    group: 'Organization',
    label: 'Branding',
    description: 'Custom logo, product branding & enterprise white-labeling',
    icon: PaintBrushIcon,
  },
  {
    id: 'git',
    category: 'organization',
    group: 'Organization',
    label: 'Git Integration',
    description: 'Account-wide GitHub connections and managed Git policies',
    icon: GitBranchIcon,
  },
  {
    id: 'tokens',
    category: 'organization',
    group: 'Organization',
    label: 'Service API Keys',
    description: 'Machine identities and automation tokens for CI/CD runners',
    icon: KeyIcon,
  },

  // Organization Settings — Access & IAM
  {
    id: 'members',
    category: 'organization',
    group: 'Access & IAM',
    label: 'Members & Roles',
    description: 'Team directory, invitation management & role assignments',
    icon: UsersIcon,
  },
  {
    id: 'groups',
    category: 'organization',
    group: 'Access & IAM',
    label: 'User Groups',
    description: 'Permission pools and group access management',
    icon: UsersIcon,
  },
  {
    id: 'access-projects',
    category: 'organization',
    group: 'Access & IAM',
    label: 'Projects Access',
    description: 'Project grants and access control matrix',
    icon: FolderOpenIcon,
  },
  {
    id: 'roles',
    category: 'organization',
    group: 'Access & IAM',
    label: 'Custom Roles',
    description: 'Enterprise custom roles and granular IAM permissions',
    icon: ShieldIcon,
  },
  {
    id: 'identity',
    category: 'organization',
    group: 'Access & IAM',
    label: 'Identity & SSO',
    description: 'SAML 2.0 Single Sign-On and SCIM directory sync',
    icon: FingerprintIcon,
  },

  // Organization Settings — Billing & Governance
  {
    id: 'audit',
    category: 'organization',
    group: 'Billing & Governance',
    label: 'Audit Log',
    description: 'Security audit trail of user, API, and agent actions',
    icon: ScrollIcon,
  },
  {
    id: 'billing',
    category: 'organization',
    group: 'Billing & Governance',
    label: 'Plan & Billing',
    description: 'Subscription tier, credit wallet and payment methods',
    icon: CreditCardIcon,
  },
  {
    id: 'transactions',
    category: 'organization',
    group: 'Billing & Governance',
    label: 'Usage & Credits',
    description: 'Credit consumption ledger and spend breakdown',
    icon: CoinsIcon,
  },
];

const AGENT_SECTION_ITEMS: ReadonlyArray<{
  id: AgentConfigSectionKey;
  label: string;
  group: AgentConfigSectionGroup;
  icon: typeof FileTextIcon;
}> = [
  // General
  { id: 'overview', label: 'Overview', group: 'General', icon: FileTextIcon },
  { id: 'basics', label: 'Basics', group: 'General', icon: SlidersHorizontalIcon },
  { id: 'people', label: 'People', group: 'General', icon: UsersIcon },
  { id: 'triggers', label: 'Triggers', group: 'General', icon: TimerIcon },
  // Access
  { id: 'skills', label: 'Skills', group: 'Access', icon: BookOpenTextIcon },
  { id: 'subagents', label: 'Subagents', group: 'Access', icon: TreeStructureIcon },
  { id: 'commands', label: 'Commands', group: 'Access', icon: CommandIcon },
  { id: 'extensions', label: 'Extensions', group: 'Access', icon: PuzzlePieceIcon },
  { id: 'connectors', label: 'Connectors', group: 'Access', icon: PlugsConnectedIcon },
  { id: 'secrets', label: 'Secrets', group: 'Access', icon: KeyIcon },
  { id: 'apps', label: 'Apps', group: 'Access', icon: GlobeIcon },
  { id: 'drives', label: 'Drives', group: 'Access', icon: HardDriveIcon },
  { id: 'actions', label: 'Permissions', group: 'Access', icon: TerminalWindowIcon },
  // Runtime
  { id: 'model', label: 'Model', group: 'Runtime', icon: CpuIcon },
  { id: 'tools', label: 'Tools', group: 'Runtime', icon: WrenchIcon },
  { id: 'workspace', label: 'Workspace', group: 'Runtime', icon: CubeIcon },
];

const MODEL_SUB_ITEMS: ReadonlyArray<{ id: ModelSubTab; label: string }> = [
  { id: 'providers', label: 'Providers' },
  { id: 'models', label: 'Model Lineup' },
  { id: 'custom', label: 'Custom Models' },
  { id: 'gateway', label: 'Gateway' },
  { id: 'routing', label: 'Routing Policies' },
  { id: 'overview', label: 'Costs & Budgets' },
  { id: 'logs', label: 'Gateway Logs' },
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
  const [previousCapabilitiesTab, setPreviousCapabilitiesTab] = useState<string>(
    initialResolvedCategory === 'capabilities' && initialResolvedTab !== 'models'
      ? initialResolvedTab
      : 'agents',
  );
  const [modelSubTab, setModelSubTab] = useState<ModelSubTab>(
    querySubtab ?? initialModelSubTab,
  );
  const [selectedAgent, setSelectedAgent] = useState<string | null>(queryAgent ?? null);
  const [agentSection, setAgentSection] = useState<AgentConfigSectionKey>(
    querySection ?? 'overview',
  );
  const [railFilter, setRailFilter] = useState('');
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(null);
  const [mobileRailOpen, setMobileRailOpen] = useState(false);

  // Sync state from query parameters if URL changes externally (e.g. HubLink drill-downs)
  useEffect(() => {
    if (queryCategory) setCategory(queryCategory);
    else if (queryAccountTab) setCategory('organization');
    if (queryTab) setActiveTab(queryTab);
    if (querySubtab) setModelSubTab(querySubtab);
    if (queryAgent !== null) setSelectedAgent(queryAgent);
    if (querySection) setAgentSection(querySection);
  }, [queryCategory, queryAccountTab, queryTab, querySubtab, queryAgent, querySection]);

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

  const drivesOn = useFeatureFlag(projectId, 'drives').enabled;
  const canWriteProject = useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_WRITE).allowed === true;

  const agentsList = useMemo(() => (Array.isArray(config?.agents) ? config.agents : []), [config]);
  const skillsList = useMemo(() => (Array.isArray(config?.skills) ? config.skills : []), [config]);

  const syncUrl = (
    nextCategory: SettingsCategory,
    nextTab: string,
    opts?: { agent?: string | null; section?: AgentConfigSectionKey | null; subtab?: ModelSubTab | null },
  ) => {
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    url.searchParams.set('category', nextCategory);
    if (nextCategory === 'organization') {
      url.searchParams.set('accountTab', nextTab);
      if (accountId) url.searchParams.set('accountId', accountId);
      url.searchParams.delete('tab');
    } else {
      url.searchParams.set('tab', nextTab);
      url.searchParams.delete('accountTab');
      url.searchParams.delete('accountId');
      url.searchParams.delete('accountMember');
      url.searchParams.delete('accountGroup');
      url.searchParams.delete('accountProject');
      url.searchParams.delete('accountSetup');
      url.searchParams.delete('accountProvider');
    }
    if (opts?.agent) url.searchParams.set('agent', opts.agent);
    else url.searchParams.delete('agent');
    if (opts?.section) url.searchParams.set('section', opts.section);
    else url.searchParams.delete('section');
    if (opts?.subtab) url.searchParams.set('subtab', opts.subtab);
    else url.searchParams.delete('subtab');
    window.history.replaceState(null, '', `${url.pathname}${url.search}`);
  };

  const handleSelectCategory = (nextCategory: SettingsCategory, explicitTab?: string) => {
    setCategory(nextCategory);
    setSelectedAgent(null);
    let targetTab = explicitTab ?? 'agents';
    if (!explicitTab) {
      if (nextCategory === 'capabilities') targetTab = 'agents';
      else if (nextCategory === 'personal') targetTab = 'profile';
      else if (nextCategory === 'organization') targetTab = 'settings';
    }
    setActiveTab(targetTab);
    syncUrl(nextCategory, targetTab);
  };

  const handleSelectTab = (
    itemId: string,
    opts?: { categoryOverride?: SettingsCategory; subtab?: ModelSubTab },
  ) => {
    const targetCategory = opts?.categoryOverride ?? category;
    if (targetCategory !== category) {
      setCategory(targetCategory);
    }
    if (targetCategory === 'capabilities' && itemId !== 'models') {
      setPreviousCapabilitiesTab(itemId);
    }
    setActiveTab(itemId);
    if (itemId !== 'agents') {
      setSelectedAgent(null);
    }
    if (opts?.subtab) {
      setModelSubTab(opts.subtab);
    }
    syncUrl(targetCategory, itemId, { subtab: opts?.subtab ?? null });
  };

  const handleSelectAgent = (agentName: string | null, section: AgentConfigSectionKey = 'overview') => {
    setSelectedAgent(agentName);
    setAgentSection(section);
    syncUrl('capabilities', 'agents', {
      agent: agentName,
      section: agentName ? section : null,
    });
  };

  const handleSelectAgentSection = (section: AgentConfigSectionKey) => {
    setAgentSection(section);
    syncUrl('capabilities', 'agents', {
      agent: selectedAgent,
      section,
    });
  };

  // In-shell SettingsNav adapter so child views stay 100% inside UnifiedSettingsPage
  const membersTab = useSettingsPanelStore((s) => s.membersTab);
  const settingsNav = useMemo<SettingsNav>(
    () => ({
      activeTab,
      isOpen: true,
      membersTab,
      llmProvidersTab: undefined,
      navigate: (rawTarget: string, opts?: { membersTab?: string }) => {
        if (opts?.membersTab) {
          useSettingsPanelStore.setState({ membersTab: opts.membersTab as MembersTab });
        }
        // Capabilities aliases
        if (rawTarget === 'agent' || rawTarget === 'agents') {
          handleSelectTab('agents', { categoryOverride: 'capabilities' });
          return;
        }
        if (rawTarget === 'skills') {
          handleSelectTab('skills', { categoryOverride: 'capabilities' });
          return;
        }
        if (rawTarget === 'models' || rawTarget.startsWith('llm-')) {
          handleSelectTab('models', { categoryOverride: 'capabilities' });
          return;
        }
        if (rawTarget === 'connectors' || rawTarget === 'channels' || rawTarget === 'computers') {
          handleSelectTab('connectors', { categoryOverride: 'capabilities' });
          return;
        }
        if (rawTarget === 'triggers' || rawTarget === 'schedules' || rawTarget === 'webhooks') {
          handleSelectTab('triggers', { categoryOverride: 'capabilities' });
          return;
        }
        if (rawTarget === 'secrets') {
          handleSelectTab('secrets', { categoryOverride: 'capabilities' });
          return;
        }
        if (rawTarget === 'git' || rawTarget === 'repositories') {
          handleSelectTab('git', { categoryOverride: 'capabilities' });
          return;
        }
        if (rawTarget === 'sandbox' || rawTarget === 'snapshots') {
          handleSelectTab('sandbox', { categoryOverride: 'capabilities' });
          return;
        }
        if (rawTarget === 'feature-flags' || rawTarget === 'experimental') {
          handleSelectTab('feature-flags', { categoryOverride: 'capabilities' });
          return;
        }
        if (rawTarget === 'workspace' || rawTarget === 'general') {
          handleSelectTab('general', { categoryOverride: 'capabilities' });
          return;
        }
        // Personal aliases
        if (rawTarget === 'profile' || rawTarget === 'connected') {
          handleSelectTab('profile', { categoryOverride: 'personal' });
          return;
        }
        if (rawTarget === 'security') {
          handleSelectTab('security', { categoryOverride: 'personal' });
          return;
        }
        if (rawTarget === 'appearance') {
          handleSelectTab('appearance', { categoryOverride: 'personal' });
          return;
        }
        if (rawTarget === 'sessions' || rawTarget === 'notifications') {
          handleSelectTab('notifications', { categoryOverride: 'personal' });
          return;
        }
        if (rawTarget === 'preferences') {
          handleSelectTab('preferences', { categoryOverride: 'personal' });
          return;
        }
        if (rawTarget === 'tokens' || rawTarget === 'api-keys') {
          handleSelectTab('tokens', { categoryOverride: 'personal' });
          return;
        }
        if (rawTarget === 'mcp') {
          handleSelectTab('mcp', { categoryOverride: 'personal' });
          return;
        }
        if (rawTarget === 'computer') {
          handleSelectTab('computer', { categoryOverride: 'personal' });
          return;
        }
        // Organization aliases
        const orgMap: Record<string, OrgSubTab> = {
          organization: 'settings',
          settings: 'settings',
          branding: 'branding',
          members: 'members',
          groups: 'groups',
          'access-projects': 'access-projects',
          roles: 'roles',
          identity: 'identity',
          audit: 'audit',
          billing: 'billing',
          plan: 'billing',
          usage: 'transactions',
          transactions: 'transactions',
          credits: 'transactions',
        };
        if (Object.hasOwn(orgMap, rawTarget)) {
          handleSelectTab(orgMap[rawTarget]!, { categoryOverride: 'organization' });
        }
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeTab, membersTab, category, accountId],
  );

  // Grouped nav items for the sidebar (supports cross-category search when railFilter is non-empty)
  const groupedCategoryItems = useMemo(() => {
    const q = railFilter.trim().toLowerCase();
    const pool = q
      ? NAV_ITEMS.filter(
          (item) =>
            item.label.toLowerCase().includes(q) ||
            item.description.toLowerCase().includes(q) ||
            item.group.toLowerCase().includes(q),
        )
      : NAV_ITEMS.filter((item) => item.category === category);

    const groups = new Map<string, NavItemDef[]>();
    for (const item of pool) {
      const groupTitle = q
        ? `${capitalizeWords(item.category)} · ${item.group}`
        : item.group;
      const list = groups.get(groupTitle) ?? [];
      list.push(item);
      groups.set(groupTitle, list);
    }
    return [...groups.entries()];
  }, [category, railFilter]);

  // Grouped agent config sections
  const groupedAgentSections = useMemo(() => {
    const visible = AGENT_SECTION_ITEMS.filter((s) => drivesOn || s.id !== 'drives');
    const groups = new Map<AgentConfigSectionGroup, typeof visible>();
    for (const item of visible) {
      const list = groups.get(item.group) ?? [];
      list.push(item);
      groups.set(item.group, list);
    }
    return [...groups.entries()];
  }, [drivesOn]);

  const itemCountFor = (itemId: string, itemCategory: SettingsCategory): number | undefined => {
    if (itemCategory === 'capabilities') {
      if (itemId === 'agents' && agentsList.length > 0) return agentsList.length;
      if (itemId === 'skills' && skillsList.length > 0) return skillsList.length;
    }
    return undefined;
  };

  const planTier = accountState?.tier?.name ?? 'Enterprise';

  const currentSubmenuLabel = useMemo(() => {
    if (category === 'capabilities') {
      if (activeTab === 'agents') {
        if (selectedAgent) {
          const currentSection = AGENT_SECTION_ITEMS.find((s) => s.id === agentSection);
          const name = agentDisplayName(selectedAgent) || capitalizeWords(selectedAgent);
          return `${name} · ${currentSection?.label ?? 'Overview'}`;
        }
        return 'Agents';
      }
      if (activeTab === 'models') {
        const currentSub = MODEL_SUB_ITEMS.find((s) => s.id === modelSubTab);
        return `Models · ${currentSub?.label ?? 'Overview'}`;
      }
    }
    const currentItem = NAV_ITEMS.find(
      (item) => item.id === activeTab && item.category === category,
    );
    return currentItem?.label ?? capitalizeWords(activeTab);
  }, [category, activeTab, selectedAgent, agentSection, modelSubTab]);

  const renderRailContent = (onItemSelect?: () => void) => {
    if (category === 'capabilities' && activeTab === 'agents' && selectedAgent) {
      return (
        <>
          <div className="border-border space-y-2.5 border-b p-3">
            <button
              type="button"
              onClick={() => {
                handleSelectAgent(null);
                onItemSelect?.();
              }}
              className="text-muted-foreground hover:text-foreground hover:bg-hover flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium transition-colors cursor-pointer"
            >
              <ArrowLeftIcon className="size-3.5 shrink-0" />
              <span>Back to all agents</span>
            </button>

            {/* Quick Agent Switcher Dropdown */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="bg-popover border-border hover:bg-hover flex w-full items-center justify-between gap-2.5 rounded-md border px-2.5 py-2 text-left transition-colors cursor-pointer"
                >
                  <span className="flex min-w-0 items-center gap-2.5">
                    <AgentMark slug={selectedAgent} />
                    <span className="min-w-0 flex-1">
                      <span className="text-foreground block truncate text-xs font-semibold">
                        {agentDisplayName(selectedAgent) || capitalizeWords(selectedAgent)}
                      </span>
                      <span className="text-muted-foreground block truncate font-mono text-xs">
                        {selectedAgent}
                      </span>
                    </span>
                  </span>
                  <CaretUpDownIcon className="text-muted-foreground size-3.5 shrink-0" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-56">
                {agentsList.map((ag) => {
                  const isSelected = ag.name === selectedAgent;
                  return (
                    <DropdownMenuItem
                      key={ag.name}
                      onSelect={() => {
                        handleSelectAgent(ag.name, agentSection);
                        onItemSelect?.();
                      }}
                      className="flex items-center justify-between gap-2 cursor-pointer"
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <AgentMark slug={ag.name} />
                        <span className="truncate text-xs font-medium">
                          {agentDisplayName(ag.name) || capitalizeWords(ag.name)}
                        </span>
                      </span>
                      {isSelected ? <CheckIcon className="size-3.5 shrink-0" /> : null}
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          <nav
            aria-label="Agent configuration sections"
            className="flex-1 space-y-4 overflow-y-auto px-2.5 py-3"
          >
            {groupedAgentSections.map(([groupName, items]) => (
              <div key={groupName} className="space-y-0.5">
                <div className="text-muted-foreground px-2.5 py-1 text-xs font-medium">
                  {groupName}
                </div>
                {items.map((sec) => {
                  const isSecActive = agentSection === sec.id;
                  const SecIcon = sec.icon;
                  return (
                    <button
                      key={sec.id}
                      type="button"
                      onClick={() => {
                        handleSelectAgentSection(sec.id);
                        onItemSelect?.();
                      }}
                      className={cn(
                        'flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-xs font-medium transition-colors cursor-pointer',
                        isSecActive
                          ? 'bg-active text-foreground font-semibold'
                          : 'text-muted-foreground hover:bg-hover hover:text-foreground',
                      )}
                    >
                      <SecIcon
                        className={cn(
                          'size-4 shrink-0',
                          isSecActive ? 'text-foreground' : 'text-muted-foreground',
                        )}
                      />
                      <span className="truncate">{sec.label}</span>
                    </button>
                  );
                })}
              </div>
            ))}
          </nav>
        </>
      );
    }

    if (category === 'capabilities' && activeTab === 'models') {
      return (
        <>
          <div className="border-border space-y-2.5 border-b p-3">
            <button
              type="button"
              onClick={() => {
                handleSelectTab(previousCapabilitiesTab || 'agents');
                onItemSelect?.();
              }}
              className="text-muted-foreground hover:text-foreground hover:bg-hover flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium transition-colors cursor-pointer"
            >
              <ArrowLeftIcon className="size-3.5 shrink-0" />
              <span>Back to capabilities</span>
            </button>

            <div className="bg-popover border-border flex items-center gap-2.5 rounded-md border px-3 py-2">
              <CpuIcon className="text-foreground size-4 shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="text-foreground truncate text-xs font-semibold">
                  Models & Routing
                </p>
                <p className="text-muted-foreground truncate text-xs">
                  Providers, lineup & gateway
                </p>
              </div>
            </div>
          </div>

          <nav
            aria-label="Models sections"
            className="flex-1 space-y-0.5 overflow-y-auto px-2.5 py-3"
          >
            {MODEL_SUB_ITEMS.map((sub) => {
              const isSubActive = modelSubTab === sub.id;
              return (
                <button
                  key={sub.id}
                  type="button"
                  onClick={() => {
                    setModelSubTab(sub.id);
                    syncUrl('capabilities', 'models', { subtab: sub.id });
                    onItemSelect?.();
                  }}
                  className={cn(
                    'flex h-8 w-full items-center rounded-md px-2.5 text-xs font-medium transition-colors cursor-pointer',
                    isSubActive
                      ? 'bg-active text-foreground font-semibold'
                      : 'text-muted-foreground hover:bg-hover hover:text-foreground',
                  )}
                >
                  <span className="truncate">{sub.label}</span>
                </button>
              );
            })}
          </nav>
        </>
      );
    }

    return (
      <>
        <div className="border-border border-b p-2.5">
          <InputGroupSearch>
            <InputGroupSearchIcon>
              <MagnifyingGlassIcon />
            </InputGroupSearchIcon>
            <InputGroupSearchInput
              placeholder="Jump to setting…"
              value={railFilter}
              onChange={(e) => setRailFilter(e.target.value)}
              variant="popover"
              size="sm"
            />
            <InputGroupSearchClear onClick={() => setRailFilter('')} />
          </InputGroupSearch>
        </div>

        <nav
          aria-label="Settings navigation"
          className="flex-1 space-y-5 overflow-y-auto px-2.5 py-3"
        >
          {groupedCategoryItems.length === 0 ? (
            <p className="text-muted-foreground px-2.5 py-4 text-center text-xs">
              No matching settings
            </p>
          ) : (
            groupedCategoryItems.map(([groupTitle, items]) => (
              <div key={groupTitle} className="space-y-0.5">
                <div className="text-muted-foreground px-2.5 py-1 text-xs font-medium">
                  {groupTitle}
                </div>
                {items.map((item) => {
                  const isActive =
                    activeTab === item.id && item.category === category;
                  const Icon = item.icon;
                  const count = itemCountFor(item.id, item.category);

                  return (
                    <button
                      key={`${item.category}-${item.id}`}
                      type="button"
                      onClick={() => {
                        setRailFilter('');
                        handleSelectTab(item.id, {
                          categoryOverride: item.category,
                        });
                        onItemSelect?.();
                      }}
                      className={cn(
                        'flex h-8 w-full items-center justify-between gap-2 rounded-md px-2.5 text-xs font-medium transition-colors cursor-pointer',
                        isActive
                          ? 'bg-active text-foreground font-semibold'
                          : 'text-muted-foreground hover:bg-hover hover:text-foreground',
                      )}
                    >
                      <span className="flex min-w-0 items-center gap-2.5">
                        <Icon
                          className={cn(
                            'size-4 shrink-0',
                            isActive ? 'text-foreground' : 'text-muted-foreground',
                          )}
                        />
                        <span className="truncate">{item.label}</span>
                      </span>
                      {count !== undefined ? (
                        <CountBadge count={count} />
                      ) : item.drilldown ? (
                        <CaretRightIcon className="text-muted-foreground size-3.5 shrink-0" />
                      ) : null}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </nav>
      </>
    );
  };

  return (
    <SettingsNavProvider value={settingsNav}>
      <div className="bg-background text-foreground flex h-dvh w-full flex-col overflow-hidden">
        {/* ── Top Bar ── */}
        <header className="border-border bg-background flex h-13 w-full shrink-0 items-center justify-between gap-2 border-b px-3 sm:gap-4 sm:px-5">
          <div className="flex min-w-0 items-center gap-3">
            <Link
              href={`/projects/${projectId}`}
              className="text-muted-foreground hover:text-foreground flex items-center gap-2 rounded-md px-2 py-1 text-xs font-medium transition-colors"
            >
              <ArrowLeftIcon className="size-3.5 shrink-0" />
              <span className="hidden sm:inline">Workspace</span>
            </Link>
            <span aria-hidden className="bg-border h-4 w-px shrink-0" />
            <div className="flex min-w-0 items-center gap-2">
              <EntityAvatar
                label={project?.name ?? 'Workspace'}
                glyph={project?.icon_glyph}
                emoji={project?.icon}
                size="xs"
              />
              <span className="text-foreground truncate text-sm font-medium">
                {project?.name ?? 'Workspace'}
              </span>
            </div>
          </div>

          {/* Canonical Segmented Category Switcher */}
          <Tabs
            value={category}
            onValueChange={(next) => handleSelectCategory(next as SettingsCategory)}
          >
            <TabsList aria-label="Settings categories">
              <TabsTrigger value="capabilities" className="gap-1 sm:gap-1.5 px-2 sm:px-3 text-xs">
                <SparkleIcon className="size-3.5" />
                <span>Capabilities</span>
              </TabsTrigger>
              <TabsTrigger value="personal" className="gap-1 sm:gap-1.5 px-2 sm:px-3 text-xs">
                <UserIcon className="size-3.5" />
                <span>Personal</span>
              </TabsTrigger>
              <TabsTrigger value="organization" className="gap-1 sm:gap-1.5 px-2 sm:px-3 text-xs">
                <GearSixIcon className="size-3.5" />
                <span>Organization</span>
              </TabsTrigger>
            </TabsList>
          </Tabs>

          {/* Account / Plan Status */}
          <div className="hidden sm:flex shrink-0 items-center gap-2">
            <Badge variant="secondary" size="xs">
              {capitalizeWords(planTier)}
            </Badge>
          </div>
        </header>

        {/* ── Mobile Submenu Bar (md:hidden) ── */}
        <div className="border-border bg-pane flex h-10 w-full shrink-0 items-center justify-between border-b px-3 md:hidden">
          <button
            type="button"
            onClick={() => setMobileRailOpen(true)}
            className="bg-background hover:bg-hover border-border text-foreground flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium shadow-2xs transition-colors cursor-pointer"
            aria-label="Open customize submenu"
          >
            <SlidersHorizontalIcon className="text-muted-foreground size-3.5 shrink-0" />
            <span className="truncate max-w-[190px]">{currentSubmenuLabel}</span>
            <CaretDownIcon className="text-muted-foreground size-3 shrink-0" />
          </button>

          {category === 'capabilities' && activeTab === 'agents' && selectedAgent ? (
            <button
              type="button"
              onClick={() => handleSelectAgent(null)}
              className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-xs font-medium transition-colors cursor-pointer"
            >
              <ArrowLeftIcon className="size-3.5 shrink-0" />
              <span>All agents</span>
            </button>
          ) : category === 'capabilities' && activeTab === 'models' ? (
            <button
              type="button"
              onClick={() => handleSelectTab(previousCapabilitiesTab || 'agents')}
              className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-xs font-medium transition-colors cursor-pointer"
            >
              <ArrowLeftIcon className="size-3.5 shrink-0" />
              <span>Capabilities</span>
            </button>
          ) : null}
        </div>

        {/* ── Mobile Submenu Sheet ── */}
        <Sheet open={mobileRailOpen} onOpenChange={setMobileRailOpen}>
          <SheetContent side="left" className="bg-pane w-72 p-0 flex flex-col h-full border-r" showCloseButton={true}>
            <SheetHeader className="border-border border-b px-3 py-2.5">
              <SheetTitle className="text-muted-foreground text-xs font-semibold uppercase tracking-wider">
                Customize & Settings
              </SheetTitle>
            </SheetHeader>
            <div className="border-border border-b p-2">
              <Tabs
                value={category}
                onValueChange={(next) => handleSelectCategory(next as SettingsCategory)}
                className="w-full"
              >
                <TabsList className="w-full grid grid-cols-3">
                  <TabsTrigger value="capabilities" className="text-xs px-1">
                    Capabilities
                  </TabsTrigger>
                  <TabsTrigger value="personal" className="text-xs px-1">
                    Personal
                  </TabsTrigger>
                  <TabsTrigger value="organization" className="text-xs px-1">
                    Organization
                  </TabsTrigger>
                </TabsList>
              </Tabs>
            </div>
            <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
              {renderRailContent(() => setMobileRailOpen(false))}
            </div>
          </SheetContent>
        </Sheet>

        {/* ── Main Layout: Full Bleed Shell ── */}
        <div className="flex min-h-0 w-full flex-1 overflow-hidden">
          {/* ── Secondary Settings Rail (bg-pane) ── */}
          <aside className="border-border bg-pane hidden h-full w-64 shrink-0 flex-col border-r md:flex overflow-hidden">
            {renderRailContent()}
          </aside>

          {/* ── Main Content Canvas ── */}
          <main className="bg-background h-full min-w-0 flex-1 overflow-y-auto">
            <div
              className={cn(
                'mx-auto px-6 py-8 pb-32 sm:px-10',
                category === 'organization' ? 'max-w-5xl' : 'max-w-4xl',
              )}
            >
              {/* 1. Capabilities Tab Views */}
              {category === 'capabilities' && activeTab === 'agents' && (
                selectedAgent ? (
                  <AgentPage
                    projectId={projectId}
                    agentName={selectedAgent}
                    onBack={() => handleSelectAgent(null)}
                  />
                ) : (
                  <AgentsPage
                    projectId={projectId}
                    onSelectAgent={(name) => handleSelectAgent(name)}
                  />
                )
              )}

              {category === 'capabilities' && activeTab === 'skills' && (
                <SkillsPage projectId={projectId} />
              )}

              {category === 'capabilities' && activeTab === 'tools' && (
                <ToolsPage projectId={projectId} />
              )}

              {category === 'capabilities' && activeTab === 'review' && (
                <ReviewPage projectId={projectId} />
              )}

              {/* Models View */}
              {category === 'capabilities' && activeTab === 'models' && (
                <div className="space-y-6">
                  <div className="border-border flex flex-col gap-2 border-b pb-4 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <h2 className="text-foreground text-xl font-medium tracking-tight">
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
                    onTabChange={(nextTab) => {
                      const resolved = nextTab as ModelSubTab;
                      setModelSubTab(resolved);
                      syncUrl('capabilities', 'models', { subtab: resolved });
                    }}
                    canWrite={canWriteProject}
                    enabled={true}
                    selectedProviderId={selectedProviderId}
                    onSelectProvider={setSelectedProviderId}
                    providersVariant="split"
                  />
                </div>
              )}

              {category === 'capabilities' && activeTab === 'connectors' && (
                <ConnectorsPage projectId={projectId} />
              )}
              {category === 'capabilities' && activeTab === 'extensions' && (
                <ExtensionsPage projectId={projectId} />
              )}
              {category === 'capabilities' && activeTab === 'triggers' && (
                <TriggersPage projectId={projectId} />
              )}
              {category === 'capabilities' && activeTab === 'secrets' && (
                <SecretsPage projectId={projectId} />
              )}
              {category === 'capabilities' && activeTab === 'general' && (
                <GeneralTab projectId={projectId} />
              )}
              {category === 'capabilities' && activeTab === 'git' && (
                <div className="space-y-6">
                  <div className="border-border flex flex-col gap-1 border-b pb-4">
                    <h2 className="text-foreground text-xl font-medium tracking-tight">
                      Git
                    </h2>
                    <p className="text-muted-foreground text-sm">
                      Configure your linked repository, active branches, terminal access, and team collaborators.
                    </p>
                  </div>
                  <GitView projectId={projectId} />
                </div>
              )}
              {category === 'capabilities' && activeTab === 'drives' && (
                <div className="space-y-6">
                  <div className="border-border flex flex-col gap-1 border-b pb-4">
                    <h2 className="text-foreground text-xl font-medium tracking-tight">
                      Drives & Storage
                    </h2>
                    <p className="text-muted-foreground text-sm">
                      Configure persistent workspace storage volumes, mounts, and shared folders.
                    </p>
                  </div>
                  <AgentDrivesSection projectId={projectId} />
                </div>
              )}
              {category === 'capabilities' && activeTab === 'sandbox' && (
                <div className="space-y-8">
                  <SandboxTab projectId={projectId} />
                  <SnapshotsTab projectId={projectId} />
                </div>
              )}
              {category === 'capabilities' && activeTab === 'members' && (
                <div className="space-y-6">
                  <div className="border-border flex flex-col gap-1 border-b pb-4">
                    <h2 className="text-foreground text-xl font-medium tracking-tight">
                      Members & Access
                    </h2>
                    <p className="text-muted-foreground text-sm">
                      Manage project members, roles, and collaborative workspace access permissions.
                    </p>
                  </div>
                  <BillingAccountProvider accountId={accountId ?? null}>
                    <EmbeddedAccountHubProvider value={{ accountId: accountId ?? '', tab: 'access-projects' }}>
                      <AccountHubSheetProvider>
                        <AccountHubContent />
                      </AccountHubSheetProvider>
                    </EmbeddedAccountHubProvider>
                  </BillingAccountProvider>
                </div>
              )}
              {category === 'capabilities' && activeTab === 'feature-flags' && (
                <ExperimentalTab projectId={projectId} />
              )}

              {/* 2. Personal Tab Views */}
              {category === 'personal' && activeTab === 'profile' && <ProfileTab />}
              {category === 'personal' && activeTab === 'security' && <SecurityTab />}
              {category === 'personal' && activeTab === 'appearance' && <AppearanceTab />}
              {category === 'personal' && activeTab === 'notifications' && (
                <SessionsTab />
              )}
              {category === 'personal' && activeTab === 'preferences' && <PreferencesTab />}
              {category === 'personal' && activeTab === 'tokens' && (
                <TokensTab accountId={accountId} />
              )}
              {category === 'personal' && activeTab === 'mcp' && <McpTab />}
              {category === 'personal' && activeTab === 'computer' && (
                <ComputerTab projectId={projectId} />
              )}

              {/* 3. Organization Tab Views (Embedded Account Hub Engine) */}
              {category === 'organization' && (
                <BillingAccountProvider accountId={accountId ?? null}>
                  <EmbeddedAccountHubProvider value={{ accountId: accountId ?? '', tab: String(activeTab) }}>
                    <AccountHubSheetProvider>
                      <AccountHubContent />
                    </AccountHubSheetProvider>
                  </EmbeddedAccountHubProvider>
                </BillingAccountProvider>
              )}
            </div>
          </main>
        </div>
      </div>
    </SettingsNavProvider>
  );
}
