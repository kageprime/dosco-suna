'use client';

import React, { useState, useMemo, useEffect } from 'react';
import {
  GearSixIcon,
  PaintBrushIcon,
  TranslateIcon,
  BellIcon,
  CpuIcon,
  RobotIcon,
  SparkleIcon,
  WrenchIcon,
  CubeIcon,
  GitBranchIcon,
  KeyIcon,
  PlugsConnectedIcon,
  HardDrivesIcon,
  FlaskIcon,
  UsersIcon,
  CreditCardIcon,
  CoinsIcon,
  ShieldCheckIcon,
  DesktopIcon,
  ScrollIcon,
  XIcon,
  MagnifyingGlassIcon,
  CaretRightIcon,
} from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import { getProjectDetail } from '@kortix/sdk';
import { contract, qk, useFeatureFlag } from '@kortix/sdk/react';
import { capitalizeWords } from '@kortix/shared';
import { Modal, ModalContent } from '@kortix/ui/modal';
import { EntityAvatar } from '@kortix/ui/entity-avatar';
import { Button } from '@kortix/ui/button';
import { cn } from '@kortix/ui';
import { useAuth } from '@/features/providers/auth-provider';
import { useSettingsPanelStore, type MembersTab } from '@kortix/ui/internal/stores/settings-panel-store';
import { useSettingsAccountId } from './use-settings-account-id';
import { BillingAccountProvider } from '@kortix/ui/internal/stores/billing-account-context';
import { AccountHubSheetProvider } from '@kortix/ui/internal/account-hub/hub-sheet';
import { SettingsNavProvider, type SettingsNav } from '@kortix/ui/internal/layout/settings-nav-context';
import { PROJECT_ACTIONS, useProjectCan } from '@kortix/ui/workspace';

// Personal & Application Tabs
import { ApplicationGeneralTab } from './tabs/application-general-tab';
import { ProfileTab } from './tabs/profile-tab';
import { SecurityTab } from './tabs/security-tab';
import { AppearanceTab } from './tabs/appearance-tab';
import { SessionsTab } from './tabs/sessions-tab';
import { PreferencesTab } from './tabs/preferences-tab';
import { McpTab } from './tabs/mcp-tab';
import { ComputerTab } from './tabs/computer-tab';

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
  type AgentConfigSectionKey,
} from '@kortix/ui/customize';
import { AgentPage } from '@kortix/ui/customize/agents/agent-page';
import { GeneralTab } from '@kortix/ui/customize/settings/tabs/general-tab';
import { SandboxTab } from '@kortix/ui/customize/settings/tabs/sandbox-tab';
import { SnapshotsTab } from '@kortix/ui/customize/settings/tabs/snapshots-tab';
import { ExperimentalTab } from '@kortix/ui/customize/settings/tabs/experimental-tab';
import { TokensTab } from '@kortix/ui/customize/settings/tabs/tokens-tab';
import { PlanTab } from './tabs/plan-tab';
import { CreditsTab } from './tabs/credits-tab';

// Organization Tabs (Account Hub)
import { AccountHubContent } from '@/features/accounts/hub/account-hub-content';

export type SettingsNavTabId =
  | 'application'
  | 'appearance'
  | 'shortcuts'
  | 'notifications'
  | 'models'
  // Workspace-scoped
  | 'workspace'
  | 'agents'
  | 'skills'
  | 'tools'
  | 'sandbox'
  | 'git'
  | 'secrets'
  | 'connectors'
  | 'drives'
  | 'feature-flags'
  // Organization-scoped
  | 'org-members'
  | 'plan'
  | 'credits'
  | 'tokens'
  | 'mcp'
  | 'computer'
  | 'org-audit'
  // Personal
  | 'profile'
  | 'security';

interface RailItemDef {
  id: SettingsNavTabId;
  label: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
  section: 'app' | 'project' | 'organization';
}

const RAIL_ITEMS: readonly RailItemDef[] = [
  // Global / App
  {
    id: 'application',
    label: 'General',
    description: 'Manage application preferences, background tasks, and version.',
    icon: GearSixIcon,
    section: 'app',
  },
  {
    id: 'appearance',
    label: 'Appearance',
    description: 'Interface themes, color palettes, typography, and density.',
    icon: PaintBrushIcon,
    section: 'app',
  },
  {
    id: 'shortcuts',
    label: 'Shortcuts',
    description: 'Language localization and keyboard shortcut cheat sheet.',
    icon: TranslateIcon,
    section: 'app',
  },
  {
    id: 'notifications',
    label: 'Notifications',
    description: 'Agent session completion alerts and sound effects.',
    icon: BellIcon,
    section: 'app',
  },
  {
    id: 'models',
    label: 'Models',
    description: 'Managed OpenRouter catalog, BYOK provider API keys, and routing budgets.',
    icon: CpuIcon,
    section: 'app',
  },

  // Project (Workspace)
  {
    id: 'workspace',
    label: 'General',
    description: 'Workspace identity, icon, name, and project lifecycle.',
    icon: GearSixIcon,
    section: 'project',
  },
  {
    id: 'agents',
    label: 'Agents',
    description: 'Default agent persona, system instructions, and tool assignments.',
    icon: RobotIcon,
    section: 'project',
  },
  {
    id: 'skills',
    label: 'Skills & Tools',
    description: 'Repository skills catalog and custom CLI tools.',
    icon: SparkleIcon,
    section: 'project',
  },
  {
    id: 'sandbox',
    label: 'Sandboxes & Snapshots',
    description: 'E2B Cloud Hypervisor microVM templates and build history.',
    icon: CubeIcon,
    section: 'project',
  },
  {
    id: 'git',
    label: 'Git Repository',
    description: 'Connected repository, target branches, and sync policies.',
    icon: GitBranchIcon,
    section: 'project',
  },
  {
    id: 'secrets',
    label: 'Secrets',
    description: 'Project API keys, encrypted credentials, and environment variables.',
    icon: KeyIcon,
    section: 'project',
  },
  {
    id: 'connectors',
    label: 'Connectors',
    description: 'Third-party integrations with Slack, GitHub, Linear, Google Drive & Notion.',
    icon: PlugsConnectedIcon,
    section: 'project',
  },
  {
    id: 'feature-flags',
    label: 'Feature Flags',
    description: 'Beta capabilities and platform experimental switches.',
    icon: FlaskIcon,
    section: 'project',
  },

  // Organization
  {
    id: 'org-members',
    label: 'Members & Roles',
    description: 'Organization directory, invitations, and role-based permissions.',
    icon: UsersIcon,
    section: 'organization',
  },
  {
    id: 'plan',
    label: 'Plan & Billing',
    description: 'Subscription tier, payment methods, and billing portal.',
    icon: CreditCardIcon,
    section: 'organization',
  },
  {
    id: 'credits',
    label: 'Usage & Credits',
    description: 'Wallet balance, credit consumption ledger, and spend history.',
    icon: CoinsIcon,
    section: 'organization',
  },
  {
    id: 'tokens',
    label: 'Personal Access Keys',
    description: 'Personal tokens for CLI automation and external scripts.',
    icon: KeyIcon,
    section: 'organization',
  },
  {
    id: 'mcp',
    label: 'MCP & Computer',
    description: 'Model Context Protocol endpoints and local computer pairing.',
    icon: DesktopIcon,
    section: 'organization',
  },
  {
    id: 'org-audit',
    label: 'Audit Log',
    description: 'Security audit trail of user, API, and agent activities.',
    icon: ScrollIcon,
    section: 'organization',
  },
];

export interface UnifiedSettingsModalProps {
  projectId?: string;
}

export function UnifiedSettingsModal({ projectId }: UnifiedSettingsModalProps) {
  const open = useSettingsPanelStore((s) => s.open);
  const storeTab = useSettingsPanelStore((s) => s.tab);
  const setStoreTab = useSettingsPanelStore((s) => s.setTab);
  const close = useSettingsPanelStore((s) => s.close);
  const membersTab = useSettingsPanelStore((s) => s.membersTab);

  const { user } = useAuth();
  const identityName = user?.user_metadata?.name?.trim() || user?.email?.split('@')[0] || 'User';
  const identityEmail = user?.email || '';

  // Project Detail Query
  const detail = useQuery({
    queryKey: qk.project.detail(projectId ?? ''),
    queryFn: () => getProjectDetail(projectId!),
    enabled: open && !!projectId,
    ...contract('config'),
  });
  const project = detail.data?.project;
  const projectAccountId = project?.account_id;
  const resolvedAccountId = useSettingsAccountId(projectAccountId);
  const canWriteProject = useProjectCan(projectId ?? '', PROJECT_ACTIONS.PROJECT_WRITE).allowed === true;

  // Active Tab Mapping
  const [activeTab, setActiveTab] = useState<SettingsNavTabId>('application');
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [modelSubTab, setModelSubTab] = useState<'providers' | 'models' | 'custom' | 'gateway' | 'routing' | 'overview' | 'logs'>('providers');
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(null);

  // Sync from store tab on open
  useEffect(() => {
    if (!open) return;
    if (storeTab === 'profile') setActiveTab('profile');
    else if (storeTab === 'appearance') setActiveTab('appearance');
    else if (storeTab === 'preferences') setActiveTab('shortcuts');
    else if (storeTab === 'sessions') setActiveTab('notifications');
    else if (storeTab === 'tokens') setActiveTab('tokens');
    else if (storeTab === 'plan') setActiveTab('plan');
    else if (storeTab === 'credits') setActiveTab('credits');
    else if (storeTab === 'workspace') setActiveTab('workspace');
    else if (storeTab === 'sandbox') setActiveTab('sandbox');
    else if (storeTab === 'feature-flags') setActiveTab('feature-flags');
    else if (storeTab === 'mcp' || storeTab === 'computer') setActiveTab('mcp');
  }, [open, storeTab]);

  const activeDef = useMemo(() => {
    if (activeTab === 'profile') {
      return {
        id: 'profile',
        label: 'Profile & Identity',
        description: 'Personal profile, name, avatar, and authentication details.',
      };
    }
    if (activeTab === 'security') {
      return {
        id: 'security',
        label: 'Security & 2FA',
        description: 'Two-factor authentication and signed-in devices.',
      };
    }
    return RAIL_ITEMS.find((item) => item.id === activeTab) ?? RAIL_ITEMS[0];
  }, [activeTab]);

  // SettingsNav adapter
  const settingsNav = useMemo<SettingsNav>(
    () => ({
      activeTab: activeTab as any,
      isOpen: open,
      membersTab,
      llmProvidersTab: undefined,
      navigate: (rawTarget: string, opts?: { membersTab?: string }) => {
        if (opts?.membersTab) {
          useSettingsPanelStore.setState({ membersTab: opts.membersTab as MembersTab });
        }
        if (rawTarget === 'profile') setActiveTab('profile');
        else if (rawTarget === 'security') setActiveTab('security');
        else if (rawTarget === 'appearance') setActiveTab('appearance');
        else if (rawTarget === 'notifications' || rawTarget === 'sessions') setActiveTab('notifications');
        else if (rawTarget === 'shortcuts' || rawTarget === 'preferences') setActiveTab('shortcuts');
        else if (rawTarget === 'models') setActiveTab('models');
        else if (rawTarget === 'workspace' || rawTarget === 'general') setActiveTab('workspace');
        else if (rawTarget === 'agents') setActiveTab('agents');
        else if (rawTarget === 'skills') setActiveTab('skills');
        else if (rawTarget === 'sandbox') setActiveTab('sandbox');
        else if (rawTarget === 'git') setActiveTab('git');
        else if (rawTarget === 'plan') setActiveTab('plan');
        else if (rawTarget === 'credits') setActiveTab('credits');
        else if (rawTarget === 'tokens') setActiveTab('tokens');
      },
    }),
    [activeTab, open, membersTab],
  );

  if (!open) return null;

  return (
    <SettingsNavProvider value={settingsNav}>
      <Modal open={open} onOpenChange={(next) => (next ? undefined : close())}>
        <ModalContent
          showCloseButton={false}
          closeOnOutsideClick={true}
          variant="base"
          animation="default"
          className={cn(
            'p-0 gap-0 overflow-hidden border border-border/80 shadow-2xl rounded-2xl bg-surface',
            'w-[1040px] max-w-[96vw] h-[720px] max-h-[90vh]',
            'flex flex-row',
          )}
        >
          {/* ── Left Navigation Rail (Antigravity Style) ── */}
          <aside className="w-60 shrink-0 border-r border-border/60 flex flex-col justify-between bg-sidebar/40 p-2.5 overflow-y-auto select-none">
            <div className="space-y-4">
              {/* Rail Top Title */}
              <div className="px-2 pt-1 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                Settings
              </div>

              {/* Application / Personal Group */}
              <nav aria-label="Application Settings" className="space-y-0.5">
                {RAIL_ITEMS.filter((i) => i.section === 'app').map((item) => {
                  const Icon = item.icon;
                  const isSelected = activeTab === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => {
                        setActiveTab(item.id);
                        setStoreTab(item.id as any);
                      }}
                      className={cn(
                        'w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors text-left cursor-pointer',
                        isSelected
                          ? 'bg-accent text-accent-foreground font-semibold'
                          : 'text-sidebar-foreground/75 hover:bg-hover hover:text-sidebar-foreground',
                      )}
                    >
                      <Icon className="size-4 shrink-0" />
                      <span className="truncate">{item.label}</span>
                    </button>
                  );
                })}
              </nav>

              {/* Projects (Workspace) Section */}
              <div className="space-y-1 pt-1">
                <div className="px-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center justify-between">
                  <span>Projects</span>
                  {project?.name && (
                    <span className="text-[10px] text-muted-foreground font-mono font-normal">
                      Active
                    </span>
                  )}
                </div>

                {project ? (
                  <div className="space-y-1">
                    <div className="px-2 py-1 flex items-center gap-2 text-xs font-medium text-foreground truncate">
                      <EntityAvatar
                        label={project.name}
                        glyph={project.icon_glyph}
                        emoji={project.icon}
                        size="xs"
                      />
                      <span className="truncate">{project.name}</span>
                    </div>

                    <div className="pl-2 space-y-0.5 border-l border-border/60 ml-3">
                      {RAIL_ITEMS.filter((i) => i.section === 'project').map((item) => {
                        const Icon = item.icon;
                        const isSelected = activeTab === item.id;
                        return (
                          <button
                            key={item.id}
                            type="button"
                            onClick={() => {
                              setActiveTab(item.id);
                              if (item.id === 'workspace') setStoreTab('workspace');
                              else if (item.id === 'sandbox') setStoreTab('sandbox');
                              else if (item.id === 'feature-flags') setStoreTab('feature-flags');
                            }}
                            className={cn(
                              'w-full flex items-center gap-2 px-2 py-1 rounded-md text-xs font-medium transition-colors text-left cursor-pointer',
                              isSelected
                                ? 'bg-accent text-accent-foreground font-semibold'
                                : 'text-sidebar-foreground/75 hover:bg-hover hover:text-sidebar-foreground',
                            )}
                          >
                            <Icon className="size-3.5 shrink-0" />
                            <span className="truncate">{item.label}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ) : (
                  <div className="px-2 py-1 text-xs text-muted-foreground italic">
                    No active workspace
                  </div>
                )}
              </div>

              {/* Organization Section */}
              <div className="space-y-1 pt-1">
                <div className="px-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                  Organization
                </div>
                <nav aria-label="Organization Settings" className="space-y-0.5">
                  {RAIL_ITEMS.filter((i) => i.section === 'organization').map((item) => {
                    const Icon = item.icon;
                    const isSelected = activeTab === item.id;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => {
                          setActiveTab(item.id);
                          if (item.id === 'plan') setStoreTab('plan');
                          else if (item.id === 'credits') setStoreTab('credits');
                          else if (item.id === 'tokens') setStoreTab('tokens');
                          else if (item.id === 'mcp') setStoreTab('mcp');
                        }}
                        className={cn(
                          'w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors text-left cursor-pointer',
                          isSelected
                            ? 'bg-accent text-accent-foreground font-semibold'
                            : 'text-sidebar-foreground/75 hover:bg-hover hover:text-sidebar-foreground',
                        )}
                      >
                        <Icon className="size-4 shrink-0" />
                        <span className="truncate">{item.label}</span>
                      </button>
                    );
                  })}
                </nav>
              </div>
            </div>

            {/* Rail Bottom Footer: Feedback & User Card */}
            <div className="pt-3 border-t border-border/60 space-y-2 mt-auto">
              <a
                href="https://github.com/kortix-ai/CompanyOS/issues"
                target="_blank"
                rel="noreferrer"
                className="block px-2 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
              >
                Give Feedback
              </a>

              <button
                type="button"
                onClick={() => setActiveTab('profile')}
                className={cn(
                  'w-full flex items-center gap-2.5 p-1.5 rounded-lg transition-colors text-left cursor-pointer',
                  activeTab === 'profile' ? 'bg-accent' : 'hover:bg-hover',
                )}
              >
                <EntityAvatar label={identityName} size="sm" />
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-semibold text-foreground truncate">
                    {identityName}
                  </div>
                  <div className="text-[10px] text-muted-foreground truncate">
                    {identityEmail}
                  </div>
                </div>
              </button>
            </div>
          </aside>

          {/* ── Right Main Content Area (Antigravity Style) ── */}
          <main className="flex-1 flex flex-col min-w-0 overflow-hidden bg-background">
            {/* Header: Title + Subtitle + Close 'X' Button */}
            <header className="h-16 shrink-0 border-b border-border/60 px-6 flex items-center justify-between gap-4">
              <div className="min-w-0">
                <h2 className="text-lg font-semibold text-foreground tracking-tight truncate">
                  {activeDef.label}
                </h2>
                <p className="text-xs text-muted-foreground truncate">
                  {activeDef.description}
                </p>
              </div>

              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={close}
                aria-label="Close settings"
                className="shrink-0 size-8 rounded-lg text-muted-foreground hover:text-foreground cursor-pointer"
              >
                <XIcon className="size-4" />
              </Button>
            </header>

            {/* Content Scroll Container */}
            <div className="flex-1 overflow-y-auto px-6 py-6 pb-20">
              {/* Application / General Tab */}
              {activeTab === 'application' && <ApplicationGeneralTab />}

              {/* Appearance Tab */}
              {activeTab === 'appearance' && <AppearanceTab />}

              {/* Shortcuts / Language Tab */}
              {activeTab === 'shortcuts' && <PreferencesTab />}

              {/* Notifications Tab */}
              {activeTab === 'notifications' && <SessionsTab projectId={projectId} />}

              {/* Models Tab */}
              {activeTab === 'models' && (
                <div className="space-y-6 max-w-4xl">
                  {projectId ? (
                    <div className="flex justify-end pb-2">
                      <ProjectDefaultPicker projectId={projectId} />
                    </div>
                  ) : null}
                  <LlmSections
                    projectId={projectId ?? ''}
                    tab={modelSubTab}
                    onTabChange={(nextTab) => setModelSubTab(nextTab as any)}
                    canWrite={canWriteProject}
                    enabled={true}
                    selectedProviderId={selectedProviderId}
                    onSelectProvider={setSelectedProviderId}
                    providersVariant="split"
                  />
                </div>
              )}

              {/* Project — General */}
              {activeTab === 'workspace' && (
                projectId ? <GeneralTab projectId={projectId} /> : <div className="text-sm text-muted-foreground">Select a project to configure workspace settings.</div>
              )}

              {/* Project — Agents */}
              {activeTab === 'agents' && (
                projectId ? (
                  selectedAgent ? (
                    <AgentPage projectId={projectId} agentName={selectedAgent} />
                  ) : (
                    <AgentsPage projectId={projectId} onSelectAgent={(name) => setSelectedAgent(name)} />
                  )
                ) : <div className="text-sm text-muted-foreground">Select a project to configure agents.</div>
              )}

              {/* Project — Skills & Tools */}
              {activeTab === 'skills' && (
                projectId ? (
                  <div className="space-y-8 max-w-4xl">
                    <SkillsPage projectId={projectId} />
                    <div className="border-t border-border/40 pt-6">
                      <ToolsPage projectId={projectId} />
                    </div>
                  </div>
                ) : <div className="text-sm text-muted-foreground">Select a project to configure skills.</div>
              )}

              {/* Project — Sandboxes & Snapshots */}
              {activeTab === 'sandbox' && (
                projectId ? (
                  <div className="space-y-8 max-w-4xl">
                    <SandboxTab projectId={projectId} />
                    <SnapshotsTab projectId={projectId} />
                  </div>
                ) : <div className="text-sm text-muted-foreground">Select a project to configure sandboxes.</div>
              )}

              {/* Project — Git */}
              {activeTab === 'git' && (
                projectId ? <GitView projectId={projectId} /> : <div className="text-sm text-muted-foreground">Select a project to configure Git.</div>
              )}

              {/* Project — Secrets */}
              {activeTab === 'secrets' && (
                projectId ? <SecretsPage projectId={projectId} /> : <div className="text-sm text-muted-foreground">Select a project to configure secrets.</div>
              )}

              {/* Project — Connectors */}
              {activeTab === 'connectors' && (
                projectId ? <ConnectorsPage projectId={projectId} /> : <div className="text-sm text-muted-foreground">Select a project to configure connectors.</div>
              )}

              {/* Project — Feature Flags */}
              {activeTab === 'feature-flags' && (
                projectId ? <ExperimentalTab projectId={projectId} /> : <div className="text-sm text-muted-foreground">Select a project to configure feature flags.</div>
              )}

              {/* Organization — Members & Roles */}
              {activeTab === 'org-members' && (
                <BillingAccountProvider accountId={resolvedAccountId ?? null}>
                  <AccountHubSheetProvider>
                    <AccountHubContent accountId={resolvedAccountId} section="members" embedded />
                  </AccountHubSheetProvider>
                </BillingAccountProvider>
              )}

              {/* Organization — Plan */}
              {activeTab === 'plan' && <PlanTab accountId={resolvedAccountId} />}

              {/* Organization — Credits */}
              {activeTab === 'credits' && <CreditsTab accountId={resolvedAccountId} />}

              {/* Organization — Personal Access Keys */}
              {activeTab === 'tokens' && <TokensTab accountId={resolvedAccountId} />}

              {/* Organization — MCP & Computer */}
              {activeTab === 'mcp' && (
                <div className="space-y-8 max-w-3xl">
                  <McpTab />
                  {projectId && (
                    <div className="border-t border-border/40 pt-6">
                      <ComputerTab projectId={projectId} />
                    </div>
                  )}
                </div>
              )}

              {/* Organization — Audit Log */}
              {activeTab === 'org-audit' && (
                <BillingAccountProvider accountId={resolvedAccountId ?? null}>
                  <AccountHubSheetProvider>
                    <AccountHubContent accountId={resolvedAccountId} section="audit" embedded />
                  </AccountHubSheetProvider>
                </BillingAccountProvider>
              )}

              {/* User Profile */}
              {activeTab === 'profile' && <ProfileTab />}

              {/* User Security */}
              {activeTab === 'security' && <SecurityTab />}
            </div>
          </main>
        </ModalContent>
      </Modal>
    </SettingsNavProvider>
  );
}
