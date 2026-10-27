'use client';

import { useState } from 'react';
import {
  ArrowLeftIcon,
  SparkleIcon,
  CpuIcon,
  KeyIcon,
  PlugsConnectedIcon,
  UserIcon,
  SlidersHorizontalIcon,
  InfoIcon,
  CreditCardIcon,
  SunIcon,
  MoonIcon,
  CheckIcon,
  PlusIcon,
  WrenchIcon,
  ArrowRightIcon,
  GlobeIcon,
  CodeIcon,
  FolderIcon,
} from '@phosphor-icons/react';
import { getProjectDetail } from '@kortix/sdk';
import { contract, qk } from '@kortix/sdk/react';
import { useQuery } from '@tanstack/react-query';

import { Badge } from '../../primitives/badge';
import { Button } from '../../primitives/button';
import { Input } from '../../primitives/input';
import { Switch } from '../../primitives/switch';
import { Textarea } from '../../primitives/textarea';
import { Tabs, TabsList, TabsTrigger } from '../../primitives/tabs';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../primitives/select';
import { AgentMark } from '../../internal/components/agent-mark';
import { useAccountState } from '../../internal/billing';
import { capitalizeWords } from '@kortix/shared';
import { cn } from '../../internal/lib/utils';
import { UiLink as Link, useUiPathname, useUiSearchParams, useUiRouter } from '../../providers/ui-provider';
import { ModelsPage } from '../models/models-page';
import { SecretsPage } from '../secrets/secrets-page';
import { ConnectorsPage } from '../connectors/connectors-page';
import { ProjectSettingsPage } from '../project-settings/project-settings-page';
import { GeneralTab } from '../settings/tabs/general-tab';
import { AGENT_TRAITS, type AgentTrait } from '../agents/agent-studio-view';

export type UnifiedTabKey =
  | 'customization'
  | 'models'
  | 'api-keys'
  | 'capabilities'
  | 'account'
  | 'preferences';

interface UnifiedSettingsPageProps {
  projectId: string;
  initialTab?: UnifiedTabKey;
}

/**
 * UnifiedSettingsPage — T3 Chat-inspired single-surface settings hub.
 * Consolidates Customization, Models, API Keys, Capabilities, Account, and Preferences
 * into one seamless full-page layout with a persistent HUD and conversational form design.
 */
export function UnifiedSettingsPage({
  projectId,
  initialTab = 'customization',
}: UnifiedSettingsPageProps) {
  const router = useUiRouter();
  const searchParams = useUiSearchParams();
  const requestedTab = searchParams.get('tab') as UnifiedTabKey | null;
  const [activeTab, setActiveTab] = useState<UnifiedTabKey>(requestedTab ?? initialTab);

  // Queries
  const detail = useQuery({
    queryKey: qk.project.detail(projectId),
    queryFn: () => getProjectDetail(projectId),
    enabled: !!projectId,
    ...contract('config'),
  });
  const project = detail.data?.project;
  const accountId = project?.account_id;
  const { data: accountState } = useAccountState({ accountId });

  // Customization state (Agent Persona & Prompt)
  const [agentName, setAgentName] = useState('fullstack');
  const [agentRole, setAgentRole] = useState(
    'Senior engineer who reviews PRs and writes integration tests',
  );
  const [instructions, setInstructions] = useState(
    'You are a senior full-stack software engineer. You write concise, production-ready code with strong typing, robust error handling, and unit test coverage. Always verify your changes before reporting completion.',
  );
  const [hasWebBrowsing, setHasWebBrowsing] = useState(true);
  const [hasCodeExecution, setHasCodeExecution] = useState(true);
  const [hasDriveAccess, setHasDriveAccess] = useState(false);
  const [savedNotice, setSavedNotice] = useState(false);

  // Preferences state (Claude-style appearance, typography & notifications)
  const [themeMode, setThemeMode] = useState<'system' | 'light' | 'dark'>('system');
  const [interfaceFont, setInterfaceFont] = useState('default');
  const [responseFont, setResponseFont] = useState('serif');
  const [transcriptSize, setTranscriptSize] = useState('medium');
  const [motionSetting, setMotionSetting] = useState('system');
  const [notifyCompletion, setNotifyCompletion] = useState(true);
  const [notifyMentions, setNotifyMentions] = useState(true);

  // Trait toggle handler
  const toggleTrait = (trait: AgentTrait) => {
    if (instructions.includes(trait.snippet)) {
      const cleaned = instructions
        .replace(`\n- ${trait.snippet}`, '')
        .replace(`- ${trait.snippet}`, '')
        .replace(trait.snippet, '')
        .trim();
      setInstructions(cleaned);
    } else {
      const prefix = instructions.trim() ? `${instructions.trim()}\n\n- ` : '- ';
      setInstructions(`${prefix}${trait.snippet}`);
    }
  };

  const handleSavePreferences = () => {
    setSavedNotice(true);
    setTimeout(() => setSavedNotice(false), 2500);
  };

  const planTier = accountState?.tier?.name ?? 'Free Plan';
  const promptLength = instructions.length;
  const estimatedTokens = Math.ceil(promptLength / 4);

  return (
    <div className="bg-background text-foreground flex min-h-screen w-full flex-col overflow-y-auto">
      {/* ── Top Bar (T3 Chat Navigation) ── */}
      <header className="border-border/80 bg-background/95 sticky top-0 z-20 flex h-14 shrink-0 items-center justify-between border-b px-4 backdrop-blur-sm sm:px-8">
        <Link
          href={`/projects/${projectId}`}
          className="text-muted-foreground hover:text-foreground flex items-center gap-2 text-xs font-medium transition-colors"
        >
          <ArrowLeftIcon className="size-4 shrink-0" />
          <span>Back to Workspace</span>
        </Link>

        {/* Centered Tab Pills */}
        <Tabs
          value={activeTab}
          onValueChange={(val) => setActiveTab(val as UnifiedTabKey)}
          className="hidden md:flex"
        >
          <TabsList className="bg-muted/60 h-9 p-1">
            <TabsTrigger value="customization" className="gap-1.5 text-xs">
              <SparkleIcon className="size-3.5" />
              <span>Customization</span>
            </TabsTrigger>
            <TabsTrigger value="models" className="gap-1.5 text-xs">
              <CpuIcon className="size-3.5" />
              <span>Models</span>
            </TabsTrigger>
            <TabsTrigger value="api-keys" className="gap-1.5 text-xs">
              <KeyIcon className="size-3.5" />
              <span>API Keys & Secrets</span>
            </TabsTrigger>
            <TabsTrigger value="capabilities" className="gap-1.5 text-xs">
              <PlugsConnectedIcon className="size-3.5" />
              <span>Capabilities & Tools</span>
            </TabsTrigger>
            <TabsTrigger value="account" className="gap-1.5 text-xs">
              <CreditCardIcon className="size-3.5" />
              <span>Account & Usage</span>
            </TabsTrigger>
            <TabsTrigger value="preferences" className="gap-1.5 text-xs">
              <SlidersHorizontalIcon className="size-3.5" />
              <span>Preferences</span>
            </TabsTrigger>
          </TabsList>
        </Tabs>

        {/* Right Status */}
        <div className="flex items-center gap-3">
          <Badge variant="secondary" size="xs">
            {planTier}
          </Badge>
        </div>
      </header>

      {/* ── Mobile Tab Strip ── */}
      <div className="border-border/60 bg-muted/20 flex overflow-x-auto border-b p-2 md:hidden">
        <Tabs
          value={activeTab}
          onValueChange={(val) => setActiveTab(val as UnifiedTabKey)}
          className="w-full"
        >
          <TabsList className="h-8 justify-start gap-1 bg-transparent p-0">
            <TabsTrigger value="customization" className="text-xs">
              Customization
            </TabsTrigger>
            <TabsTrigger value="models" className="text-xs">
              Models
            </TabsTrigger>
            <TabsTrigger value="api-keys" className="text-xs">
              API Keys
            </TabsTrigger>
            <TabsTrigger value="capabilities" className="text-xs">
              Capabilities
            </TabsTrigger>
            <TabsTrigger value="account" className="text-xs">
              Account
            </TabsTrigger>
            <TabsTrigger value="preferences" className="text-xs">
              Preferences
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {/* ── Main Content Grid (HUD + Form Canvas) ── */}
      <div className="mx-auto grid w-full max-w-7xl flex-1 gap-8 px-4 py-8 sm:px-8 lg:grid-cols-[260px_1fr]">
        {/* ── Left Column: Persistent HUD (T3 Chat) ── */}
        <aside className="space-y-6">
          {/* 1. Identity Card */}
          <div className="bg-popover border-border/80 flex flex-col items-center rounded-md border p-6 text-center">
            <div className="bg-muted flex size-16 items-center justify-center rounded-full">
              <AgentMark slug={agentName} />
            </div>
            <h3 className="text-foreground mt-3 text-sm font-semibold">
              {project?.name || 'Dosco Tek Workspace'}
            </h3>
            <p className="text-muted-foreground text-xs">{project?.slug || 'workspace'}</p>
            <div className="mt-3">
              <Badge variant="secondary" size="xs">
                {planTier}
              </Badge>
            </div>
          </div>

          {/* 2. Usage Limits Widget */}
          <div className="bg-popover border-border/80 space-y-3 rounded-md border p-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5 text-xs font-medium text-foreground">
                <span>Usage Limits</span>
                <InfoIcon className="text-muted-foreground size-3.5" />
              </div>
              <span className="text-muted-foreground text-xs">Standard</span>
            </div>
            <div className="space-y-1.5">
              <div className="bg-muted h-2 w-full overflow-hidden rounded-full">
                <div className="bg-kortix-blue h-full w-[28%] rounded-full" />
              </div>
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>140 / 500 Credits</span>
                <span>28%</span>
              </div>
            </div>
          </div>

          {/* 3. Keyboard Shortcuts Quick Card */}
          <div className="bg-popover border-border/80 space-y-3 rounded-md border p-4">
            <div className="text-foreground text-xs font-semibold">Keyboard Shortcuts</div>
            <div className="space-y-2 text-xs">
              <div className="flex items-center justify-between text-muted-foreground">
                <span>Quick Search</span>
                <span className="text-foreground font-mono">⌘ + K</span>
              </div>
              <div className="flex items-center justify-between text-muted-foreground">
                <span>New Session</span>
                <span className="text-foreground font-mono">⌘ + J</span>
              </div>
              <div className="flex items-center justify-between text-muted-foreground">
                <span>Toggle Sidebar</span>
                <span className="text-foreground font-mono">⌘ + B</span>
              </div>
              <div className="flex items-center justify-between text-muted-foreground">
                <span>Test Agent</span>
                <span className="text-foreground font-mono">⌘ + ↵</span>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setActiveTab('preferences')}
              className="text-kortix-blue hover:underline text-xs pt-1 block"
            >
              Customize shortcuts →
            </button>
          </div>
        </aside>

        {/* ── Right Column: Tab Content Canvas ── */}
        <main className="min-w-0 flex-1">
          {activeTab === 'customization' && (
            <div className="space-y-8">
              {/* Header */}
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <h2 className="text-foreground text-lg font-semibold tracking-tight">
                    Customize Agent Persona
                  </h2>
                  <p className="text-muted-foreground text-xs">
                    Define the behavioral rules, personality traits, and capabilities for your agent.
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground text-xs font-medium">Persona:</span>
                  <select
                    value={agentName}
                    onChange={(e) => setAgentName(e.target.value)}
                    className="border-border bg-background text-foreground h-8 rounded-md border px-2.5 text-xs font-medium"
                  >
                    <option value="fullstack">Full-Stack Engineer</option>
                    <option value="researcher">Research Analyst</option>
                    <option value="qa-sentry">QA & Bug Hunter</option>
                  </select>
                </div>
              </div>

              {/* Conversational Questions */}
              <div className="space-y-6">
                {/* Question 1 */}
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <label
                      htmlFor="custom-agent-role"
                      className="text-foreground text-xs font-medium"
                    >
                      What is this agent’s primary mission?
                    </label>
                    <span className="text-muted-foreground text-xs">{agentRole.length}/100</span>
                  </div>
                  <Input
                    id="custom-agent-role"
                    value={agentRole}
                    onChange={(e) => setAgentRole(e.target.value)}
                    placeholder="e.g. Senior engineer who reviews PRs and writes integration tests"
                    maxLength={100}
                    className="text-xs"
                  />
                </div>

                {/* Question 2: Trait Chips */}
                <div className="space-y-2.5">
                  <div className="space-y-0.5">
                    <label className="text-foreground text-xs font-medium">
                      What traits should this agent have?
                    </label>
                    <p className="text-muted-foreground text-xs">
                      Click traits to toggle behavioral directives directly in the prompt.
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {AGENT_TRAITS.map((trait) => {
                      const isActive = instructions.includes(trait.snippet);
                      return (
                        <button
                          type="button"
                          key={trait.id}
                          onClick={() => toggleTrait(trait)}
                          className={cn(
                            'flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors',
                            isActive
                              ? 'bg-kortix-blue/15 text-kortix-blue border-kortix-blue/15 ring-1 ring-border'
                              : 'bg-muted/40 text-muted-foreground hover:bg-hover hover:text-foreground border-border/60',
                          )}
                        >
                          {isActive ? (
                            <CheckIcon className="size-3 shrink-0" />
                          ) : (
                            <PlusIcon className="size-3 shrink-0 opacity-60" />
                          )}
                          <span>{trait.label}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Question 3: Operating Guidelines */}
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <label
                      htmlFor="custom-agent-instructions"
                      className="text-foreground text-xs font-medium"
                    >
                      Operating Guidelines & Prompts
                    </label>
                    <span className="text-muted-foreground text-xs">
                      {promptLength} chars (~{estimatedTokens} tokens)
                    </span>
                  </div>
                  <Textarea
                    id="custom-agent-instructions"
                    value={instructions}
                    onChange={(e) => setInstructions(e.target.value)}
                    placeholder="Provide specific guidelines, constraints, and decision rules..."
                    rows={8}
                    className="font-mono text-xs leading-relaxed"
                  />
                </div>

                {/* Superpowers */}
                <div className="space-y-2.5">
                  <label className="text-foreground text-xs font-medium">
                    What superpowers can this agent access?
                  </label>
                  <div className="bg-popover divide-border/60 divide-y rounded-md border">
                    <div className="flex items-center justify-between p-3.5">
                      <div className="flex items-center gap-3">
                        <span className="bg-kortix-blue/15 text-kortix-blue flex size-7 items-center justify-center rounded-sm">
                          <GlobeIcon className="size-3.5" />
                        </span>
                        <div>
                          <div className="text-foreground text-xs font-medium">Web Browsing & Connectors</div>
                          <div className="text-muted-foreground text-xs">Search online resources and external APIs.</div>
                        </div>
                      </div>
                      <Switch checked={hasWebBrowsing} onCheckedChange={setHasWebBrowsing} />
                    </div>

                    <div className="flex items-center justify-between p-3.5">
                      <div className="flex items-center gap-3">
                        <span className="bg-kortix-green/15 text-kortix-green flex size-7 items-center justify-center rounded-sm">
                          <CodeIcon className="size-3.5" />
                        </span>
                        <div>
                          <div className="text-foreground text-xs font-medium">Code & Sandbox Execution</div>
                          <div className="text-muted-foreground text-xs">Run terminal commands and execute code.</div>
                        </div>
                      </div>
                      <Switch checked={hasCodeExecution} onCheckedChange={setHasCodeExecution} />
                    </div>

                    <div className="flex items-center justify-between p-3.5">
                      <div className="flex items-center gap-3">
                        <span className="bg-kortix-purple/15 text-kortix-purple flex size-7 items-center justify-center rounded-sm">
                          <FolderIcon className="size-3.5" />
                        </span>
                        <div>
                          <div className="text-foreground text-xs font-medium">Workspace File Drives</div>
                          <div className="text-muted-foreground text-xs">Access persistent storage volumes.</div>
                        </div>
                      </div>
                      <Switch checked={hasDriveAccess} onCheckedChange={setHasDriveAccess} />
                    </div>
                  </div>
                </div>

                {/* Anchored Save Bar */}
                <div className="flex items-center justify-end gap-3 pt-4 border-t border-border/60">
                  {savedNotice && (
                    <span className="text-kortix-green text-xs font-medium flex items-center gap-1">
                      <CheckIcon className="size-3.5" />
                      <span>Preferences saved successfully</span>
                    </span>
                  )}
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={handleSavePreferences}
                    className="gap-1.5"
                  >
                    <span>Save Preferences</span>
                  </Button>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'models' && <ModelsPage projectId={projectId} />}

          {activeTab === 'api-keys' && <SecretsPage projectId={projectId} />}

          {activeTab === 'capabilities' && (
            <div className="space-y-6">
              <ConnectorsPage projectId={projectId} />
            </div>
          )}

          {activeTab === 'account' && (
            <div className="space-y-8">
              <div className="space-y-0.5">
                <h2 className="text-foreground text-lg font-semibold tracking-tight">Account & Billing</h2>
                <p className="text-muted-foreground text-xs">
                  Manage your subscription tier, billing contact, and workspace seats.
                </p>
              </div>
              <div className="bg-popover border-border/80 rounded-md border p-6 space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-foreground text-sm font-semibold">Active Plan: {planTier}</h3>
                    <p className="text-muted-foreground text-xs mt-0.5">
                      Unlimited agent interactions, local runtime execution, and BYOK access.
                    </p>
                  </div>
                  <Button variant="secondary" size="sm">
                    Manage Subscription
                  </Button>
                </div>
              </div>
              <GeneralTab projectId={projectId} />
            </div>
          )}

          {activeTab === 'preferences' && (
            <div className="space-y-6">
              <div className="space-y-0.5">
                <h2 className="text-foreground text-lg font-semibold tracking-tight">Preferences & Appearance</h2>
                <p className="text-muted-foreground text-xs">
                  Customize the interface typography, color theme, and notification delivery.
                </p>
              </div>

              <div className="bg-popover border-border/80 rounded-md border p-6 space-y-6">
                {/* ── Appearance Section (Claude-Style) ── */}
                <div className="space-y-4">
                  <div className="text-foreground text-sm font-semibold">Appearance</div>

                  {/* Theme Mode */}
                  <div className="flex items-center justify-between py-1">
                    <div>
                      <div className="text-foreground text-xs font-medium">Theme</div>
                      <div className="text-muted-foreground text-xs">Select your interface display mode</div>
                    </div>
                    <div className="flex items-center gap-1 bg-muted/50 p-1 rounded-md border border-border/60">
                      <Button
                        variant={themeMode === 'system' ? 'secondary' : 'ghost'}
                        size="xs"
                        onClick={() => setThemeMode('system')}
                        className="gap-1.5"
                      >
                        <SlidersHorizontalIcon className="size-3" />
                        <span>System</span>
                      </Button>
                      <Button
                        variant={themeMode === 'light' ? 'secondary' : 'ghost'}
                        size="xs"
                        onClick={() => setThemeMode('light')}
                        className="gap-1.5"
                      >
                        <SunIcon className="size-3" />
                        <span>Light</span>
                      </Button>
                      <Button
                        variant={themeMode === 'dark' ? 'secondary' : 'ghost'}
                        size="xs"
                        onClick={() => setThemeMode('dark')}
                        className="gap-1.5"
                      >
                        <MoonIcon className="size-3" />
                        <span>Dark</span>
                      </Button>
                    </div>
                  </div>

                  {/* Interface Font */}
                  <div className="flex items-center justify-between py-2 border-t border-border/40">
                    <div>
                      <div className="text-foreground text-xs font-medium">Interface font</div>
                      <div className="text-muted-foreground text-xs">Font family for navigation and controls</div>
                    </div>
                    <Select value={interfaceFont} onValueChange={setInterfaceFont}>
                      <SelectTrigger className="w-52 h-8 text-xs">
                        <SelectValue placeholder="Select interface font" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="default">Default · Dosco Sans</SelectItem>
                        <SelectItem value="system">System Sans</SelectItem>
                        <SelectItem value="mono">JetBrains Mono</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  {/* Response Font */}
                  <div className="flex items-center justify-between py-2 border-t border-border/40">
                    <div>
                      <div className="text-foreground text-xs font-medium">Response font</div>
                      <div className="text-muted-foreground text-xs">Typography for agent responses and chat turns</div>
                    </div>
                    <Select value={responseFont} onValueChange={setResponseFont}>
                      <SelectTrigger className="w-52 h-8 text-xs">
                        <SelectValue placeholder="Select response font" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="serif">Anthropic Serif (Editorial)</SelectItem>
                        <SelectItem value="sans">Modern Sans</SelectItem>
                        <SelectItem value="mono">Fira Code (Monospace)</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  {/* Transcript Text Size */}
                  <div className="flex items-center justify-between py-2 border-t border-border/40">
                    <div>
                      <div className="text-foreground text-xs font-medium">Transcript text size</div>
                      <div className="text-muted-foreground text-xs">Scale text in conversational transcripts</div>
                    </div>
                    <Select value={transcriptSize} onValueChange={setTranscriptSize}>
                      <SelectTrigger className="w-52 h-8 text-xs">
                        <SelectValue placeholder="Select text size" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="compact">Compact (13px)</SelectItem>
                        <SelectItem value="medium">Medium (14px)</SelectItem>
                        <SelectItem value="large">Large (16px)</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  {/* Motion */}
                  <div className="flex items-center justify-between py-2 border-t border-border/40">
                    <div>
                      <div className="text-foreground text-xs font-medium">Motion</div>
                      <div className="text-muted-foreground text-xs">UI transitions and animations budget</div>
                    </div>
                    <Select value={motionSetting} onValueChange={setMotionSetting}>
                      <SelectTrigger className="w-52 h-8 text-xs">
                        <SelectValue placeholder="Select motion setting" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="system">System preference</SelectItem>
                        <SelectItem value="reduced">Reduced motion</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                {/* ── Notifications Section (Claude-Style) ── */}
                <div className="border-t border-border/60 pt-6 space-y-4">
                  <div className="text-foreground text-sm font-semibold">Notifications</div>

                  <div className="flex items-center justify-between py-1">
                    <div className="pr-4">
                      <div className="text-foreground text-xs font-medium">Response completions</div>
                      <div className="text-muted-foreground text-xs">
                        Get notified when an agent has finished a response. Useful for long-running tasks.
                      </div>
                    </div>
                    <Switch checked={notifyCompletion} onCheckedChange={setNotifyCompletion} />
                  </div>

                  <div className="flex items-center justify-between py-2 border-t border-border/40">
                    <div className="pr-4">
                      <div className="text-foreground text-xs font-medium">Mentions and replies</div>
                      <div className="text-muted-foreground text-xs">
                        Get an email when someone mentions you or replies in a thread you are part of.
                      </div>
                    </div>
                    <Switch checked={notifyMentions} onCheckedChange={setNotifyMentions} />
                  </div>
                </div>

                {/* ── Global Keybindings ── */}
                <div className="border-t border-border/60 pt-6 space-y-3">
                  <div className="text-foreground text-sm font-semibold">Global Keybindings</div>
                  <div className="divide-border/60 divide-y text-xs">
                    <div className="flex items-center justify-between py-2 text-muted-foreground">
                      <span>Quick Search & Palette</span>
                      <span className="text-foreground font-mono">⌘ + K</span>
                    </div>
                    <div className="flex items-center justify-between py-2 text-muted-foreground">
                      <span>New Agent Session</span>
                      <span className="text-foreground font-mono">⌘ + J</span>
                    </div>
                    <div className="flex items-center justify-between py-2 text-muted-foreground">
                      <span>Toggle Navigation Sidebar</span>
                      <span className="text-foreground font-mono">⌘ + B</span>
                    </div>
                    <div className="flex items-center justify-between py-2 text-muted-foreground">
                      <span>Execute / Test Agent</span>
                      <span className="text-foreground font-mono">⌘ + ↵</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
