'use client';

import { useState } from 'react';
import {
  ArrowLeftIcon,
  RobotIcon,
  SparkleIcon,
  CpuIcon,
  KeyIcon,
  PlugsConnectedIcon,
  GitBranchIcon,
  CubeIcon,
  FlaskIcon,
  GearSixIcon,
} from '@phosphor-icons/react';
import { getProjectDetail } from '@kortix/sdk';
import { contract, qk } from '@kortix/sdk/react';
import { useQuery } from '@tanstack/react-query';

import { Badge } from '../../primitives/badge';
import { useAccountState } from '../../internal/billing';
import { cn } from '../../internal/lib/utils';
import { UiLink as Link, useUiSearchParams } from '../../providers/ui-provider';
import { AgentsPage } from '../agents/agents-page';
import { SkillsPage } from '../skills/skills-page';
import { ModelsPage } from '../models/models-page';
import { SecretsPage } from '../secrets/secrets-page';
import { ConnectorsPage } from '../connectors/connectors-page';
import { ProjectSettingsPage } from '../project-settings/project-settings-page';
import { GeneralTab } from '../settings/tabs/general-tab';
import { SandboxTab } from '../settings/tabs/sandbox-tab';
import { SnapshotsTab } from '../settings/tabs/snapshots-tab';
import { ExperimentalTab } from '../settings/tabs/experimental-tab';

export type UnifiedTabKey =
  | 'agents'
  | 'skills'
  | 'models'
  | 'connectors'
  | 'secrets'
  | 'git'
  | 'sandbox'
  | 'feature-flags'
  | 'general';

interface UnifiedSettingsPageProps {
  projectId: string;
  initialTab?: UnifiedTabKey;
}

/**
 * UnifiedSettingsPage (Packages/UI variant) — Centralized Capabilities hub.
 * Direct access to real agents, skills, models, connectors, secrets, and environment settings.
 */
export function UnifiedSettingsPage({
  projectId,
  initialTab = 'agents',
}: UnifiedSettingsPageProps) {
  const searchParams = useUiSearchParams();
  const requestedTab = searchParams.get('tab') as UnifiedTabKey | null;
  const [activeTab, setActiveTab] = useState<UnifiedTabKey>(requestedTab ?? initialTab);

  const detail = useQuery({
    queryKey: qk.project.detail(projectId),
    queryFn: () => getProjectDetail(projectId),
    enabled: !!projectId,
    ...contract('config'),
  });
  const project = detail.data?.project;
  const accountId = project?.account_id;
  const { data: accountState } = useAccountState({ accountId });

  const planTier = accountState?.tier?.name ?? 'Free Plan';

  const navItems = [
    { id: 'agents', label: 'Agents', icon: RobotIcon },
    { id: 'skills', label: 'Skills', icon: SparkleIcon },
    { id: 'models', label: 'Models', icon: CpuIcon },
    { id: 'connectors', label: 'Connectors', icon: PlugsConnectedIcon },
    { id: 'secrets', label: 'Secrets', icon: KeyIcon },
    { id: 'git', label: 'Git', icon: GitBranchIcon },
    { id: 'sandbox', label: 'Sandbox & Snapshots', icon: CubeIcon },
    { id: 'feature-flags', label: 'Feature Flags', icon: FlaskIcon },
    { id: 'general', label: 'General', icon: GearSixIcon },
  ] as const;

  return (
    <div className="bg-background text-foreground flex min-h-screen w-full flex-col">
      {/* ── Top Bar ── */}
      <header className="border-border/80 bg-background/95 sticky top-0 z-20 flex h-14 shrink-0 items-center justify-between border-b px-4 backdrop-blur-sm sm:px-8">
        <Link
          href={`/projects/${projectId}`}
          className="text-muted-foreground hover:text-foreground flex items-center gap-2 text-xs font-medium transition-colors"
        >
          <ArrowLeftIcon className="size-4 shrink-0" />
          <span>Back to Workspace</span>
        </Link>

        <div className="flex items-center gap-3">
          <Badge variant="secondary" size="xs">
            {planTier}
          </Badge>
        </div>
      </header>

      {/* ── Main Layout ── */}
      <div className="mx-auto flex w-full max-w-7xl flex-1 items-start gap-8 px-4 sm:px-8">
        {/* Sticky Left Submenu Rail */}
        <aside className="border-border/80 sticky top-14 hidden h-[calc(100vh-3.5rem)] w-60 shrink-0 flex-col border-r py-6 pr-4 md:flex">
          <nav className="flex flex-col gap-1">
            {navItems.map((item) => {
              const Icon = item.icon;
              const isActive = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setActiveTab(item.id as UnifiedTabKey)}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors',
                    isActive
                      ? 'bg-muted text-foreground font-semibold'
                      : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground',
                  )}
                >
                  <Icon className="size-4 shrink-0" />
                  <span>{item.label}</span>
                </button>
              );
            })}
          </nav>
        </aside>

        {/* Main Content Area */}
        <main className="min-w-0 flex-1 py-8">
          {activeTab === 'agents' && <AgentsPage projectId={projectId} />}
          {activeTab === 'skills' && <SkillsPage projectId={projectId} />}
          {activeTab === 'models' && <ModelsPage projectId={projectId} />}
          {activeTab === 'connectors' && <ConnectorsPage projectId={projectId} />}
          {activeTab === 'secrets' && <SecretsPage projectId={projectId} />}
          {activeTab === 'git' && <ProjectSettingsPage projectId={projectId} />}
          {activeTab === 'sandbox' && (
            <div className="space-y-8">
              <SandboxTab projectId={projectId} />
              <SnapshotsTab projectId={projectId} />
            </div>
          )}
          {activeTab === 'feature-flags' && <ExperimentalTab projectId={projectId} />}
          {activeTab === 'general' && <GeneralTab projectId={projectId} />}
        </main>
      </div>
    </div>
  );
}
