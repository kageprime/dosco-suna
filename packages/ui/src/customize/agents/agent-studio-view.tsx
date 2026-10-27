'use client';

import { useMemo, useState } from 'react';
import {
  GlobeIcon,
  CodeIcon,
  FolderIcon,
  LightningIcon,
  SparkleIcon,
  SlidersHorizontalIcon,
  CheckIcon,
  PlusIcon,
  WrenchIcon,
  ArrowRightIcon,
  ChatCircleDotsIcon,
} from '@phosphor-icons/react';

import { Badge } from '../../primitives/badge';
import { Button } from '../../primitives/button';
import { Switch } from '../../primitives/switch';
import { Textarea } from '../../primitives/textarea';
import { Input } from '../../primitives/input';
import { AgentMark } from '../../internal/components/agent-mark';
import { cn } from '../../internal/lib/utils';
import type { AgentDraft } from '../sections/view/agent-editor';
import type { ProjectConfigSummary } from '@kortix/sdk';
import { capitalizeWords } from '@kortix/shared';

export interface AgentBlueprint {
  id: string;
  title: string;
  description: string;
  prompt: string;
  icon: typeof SparkleIcon;
}

const BLUEPRINTS: readonly AgentBlueprint[] = [
  {
    id: 'fullstack',
    title: 'Full-Stack Engineer',
    description: 'Writes, debugs, and refactors clean code with comprehensive automated tests.',
    prompt:
      'You are a senior full-stack software engineer. You write concise, production-ready code with strong typing, robust error handling, and unit test coverage. Always verify your changes before reporting completion.',
    icon: CodeIcon,
  },
  {
    id: 'researcher',
    title: 'Research Analyst',
    description: 'Surveys web and documentation, extracts verified facts, and builds structured reports.',
    prompt:
      'You are an expert research analyst. You gather reliable sources, synthesize complex topics into concise structured takeaways, and cite real data points without speculation.',
    icon: GlobeIcon,
  },
  {
    id: 'qa-sentry',
    title: 'QA & Bug Hunter',
    description: 'Finds edge cases, audits code for security and performance regressions, and writes repros.',
    prompt:
      'You are an adversarial QA specialist and security reviewer. You inspect diffs and architectures for subtle edge cases, concurrency hazards, data leaks, and performance bottlenecks. Provide clear reproduction steps.',
    icon: LightningIcon,
  },
];

export interface AgentTrait {
  id: string;
  label: string;
  snippet: string;
}

export const AGENT_TRAITS: readonly AgentTrait[] = [
  {
    id: 'concise',
    label: 'Concise & Direct',
    snippet: 'Keep responses concise, direct, and technically precise without conversational filler.',
  },
  {
    id: 'analytical',
    label: 'Highly Analytical',
    snippet: 'Think through edge cases methodically. Break down complex problems before writing code.',
  },
  {
    id: 'friendly',
    label: 'Friendly & Warm',
    snippet: 'Maintain an approachable, encouraging, and collaborative tone.',
  },
  {
    id: 'adversarial',
    label: 'Adversarial QA',
    snippet: 'Challenge assumptions aggressively, scrutinize diffs for subtle bugs, and verify with tests.',
  },
  {
    id: 'empathetic',
    label: 'Empathetic & Supportive',
    snippet: 'Acknowledge pain points patiently and guide users through troubleshooting steps clearly.',
  },
  {
    id: 'creative',
    label: 'Creative & Exploratory',
    snippet: 'Brainstorm unconventional alternatives and offer multiple novel architectural solutions.',
  },
  {
    id: 'formal',
    label: 'Executive & Formal',
    snippet: 'Communicate in professional, executive-ready language with structured briefings.',
  },
  {
    id: 'socratic',
    label: 'Socratic & Educational',
    snippet: 'Explain the "why" behind decisions and teach principles rather than just handing over fixes.',
  },
];

interface AgentStudioViewProps {
  agentName: string;
  editor: AgentDraft;
  config: ProjectConfigSummary;
  onOpenEngine: () => void;
  onOpenPlayground: () => void;
}

/**
 * AgentStudioView — An outcome-driven, intuitive configuration experience for agents.
 * Designed for non-power users to configure agent personality, capabilities, and tools
 * with 1-click starter blueprints, T3-Chat interactive trait chips, and plain-English controls.
 */
export function AgentStudioView({
  agentName,
  editor,
  config,
  onOpenEngine,
  onOpenPlayground,
}: AgentStudioViewProps) {
  const [selectedBlueprint, setSelectedBlueprint] = useState<string | null>(null);

  const applyBlueprint = (blueprint: AgentBlueprint) => {
    setSelectedBlueprint(blueprint.id);
    editor.setOc('description', blueprint.description);
    editor.setOc('prompt', blueprint.prompt);
  };

  const currentPrompt = editor.oc.prompt ?? '';

  // Toggle trait chip in prompt
  const toggleTrait = (trait: AgentTrait) => {
    if (currentPrompt.includes(trait.snippet)) {
      // Remove snippet and clean up double newlines
      const cleaned = currentPrompt
        .replace(`\n- ${trait.snippet}`, '')
        .replace(`- ${trait.snippet}`, '')
        .replace(trait.snippet, '')
        .trim();
      editor.setOc('prompt', cleaned);
    } else {
      // Append snippet cleanly
      const prefix = currentPrompt.trim() ? `${currentPrompt.trim()}\n\n- ` : '- ';
      editor.setOc('prompt', `${prefix}${trait.snippet}`);
    }
  };

  // Determine active capabilities from editor state
  const hasWebBrowsing = Boolean(editor.draft.connectors !== 'none' || editor.oc.mode === 'primary');
  const hasCodeExecution = editor.oc.permission !== 'deny';
  const hasDriveAccess = Boolean(editor.draft.repository_access !== false);

  // Live prompt statistics
  const promptLength = currentPrompt.length;
  const estimatedTokens = Math.ceil(promptLength / 4);

  return (
    <div className="mx-auto w-full max-w-3xl space-y-8 px-4 py-8 pb-24">
      {/* ── 1. Hero Identity Banner & HUD ── */}
      <div className="bg-popover border-border/80 relative flex flex-col gap-5 rounded-md border p-6 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-4">
          <AgentMark slug={agentName} />
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <h2 className="text-foreground text-lg font-semibold tracking-tight">
                {capitalizeWords(agentName)}
              </h2>
              <Badge variant="secondary" size="xs">
                {editor.oc.mode || 'Primary'}
              </Badge>
              <span className="text-muted-foreground text-xs">
                ~{estimatedTokens} tokens
              </span>
            </div>
            <p className="text-muted-foreground text-xs">
              {editor.oc.description || 'Configure this agent’s behavior, skills, and tools.'}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={onOpenPlayground}
            className="gap-1.5 shadow-xs"
          >
            <SparkleIcon weight="fill" className="text-kortix-blue size-3.5" />
            <span>Test Agent</span>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={onOpenEngine}
            className="text-muted-foreground hover:text-foreground gap-1.5"
          >
            <SlidersHorizontalIcon className="size-3.5" />
            <span>Engine Bay</span>
          </Button>
        </div>
      </div>

      {/* ── 2. Starter Blueprints ── */}
      <section className="space-y-3">
        <div className="space-y-0.5">
          <h3 className="text-foreground text-sm font-medium">Starter Blueprints</h3>
          <p className="text-muted-foreground text-xs">
            Apply a battle-tested configuration preset with one click.
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          {BLUEPRINTS.map((bp) => {
            const Icon = bp.icon;
            const isApplied =
              selectedBlueprint === bp.id ||
              editor.oc.description?.includes(bp.description.slice(0, 20));
            return (
              <button
                type="button"
                key={bp.id}
                onClick={() => applyBlueprint(bp)}
                className={cn(
                  'bg-popover group flex flex-col items-start gap-2.5 rounded-md border p-4 text-left transition-colors',
                  isApplied
                    ? 'border-foreground/40 bg-accent/40 ring-1 ring-border'
                    : 'border-border/70 hover:border-border hover:bg-hover',
                )}
              >
                <div className="flex w-full items-center justify-between">
                  <span className="bg-muted text-foreground flex size-7 items-center justify-center rounded-sm">
                    <Icon className="size-4" />
                  </span>
                  {isApplied ? (
                    <Badge variant="kortix" size="xs">
                      Active
                    </Badge>
                  ) : (
                    <span className="text-muted-foreground group-hover:text-foreground text-xs opacity-0 transition-opacity group-hover:opacity-100">
                      Apply
                    </span>
                  )}
                </div>
                <div className="space-y-1">
                  <div className="text-foreground text-xs font-semibold">{bp.title}</div>
                  <div className="text-muted-foreground line-clamp-2 text-xs leading-relaxed">
                    {bp.description}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      </section>

      {/* ── 3. Conversational Role & Trait Chips (T3 Chat Inspired) ── */}
      <section className="space-y-4">
        <div className="space-y-0.5">
          <h3 className="text-foreground text-sm font-medium">
            How should this agent behave and communicate?
          </h3>
          <p className="text-muted-foreground text-xs">
            Click traits to toggle behavioral rules directly in the agent’s instructions.
          </p>
        </div>

        {/* 1-Click Interactive Trait Chips */}
        <div className="flex flex-wrap gap-2">
          {AGENT_TRAITS.map((trait) => {
            const isActive = currentPrompt.includes(trait.snippet);
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

        <div className="space-y-3 pt-2">
          <div className="space-y-1.5">
            <label htmlFor="agent-studio-description" className="text-muted-foreground text-xs font-medium">
              What is this agent’s primary role?
            </label>
            <Input
              id="agent-studio-description"
              value={editor.oc.description ?? ''}
              onChange={(e) => editor.setOc('description', e.target.value)}
              placeholder="e.g. Senior engineer who reviews PRs and writes integration tests"
              className="text-xs"
            />
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label htmlFor="agent-studio-instructions" className="text-muted-foreground text-xs font-medium">
                Operating Guidelines & Instructions
              </label>
              <span className="text-muted-foreground text-xs">
                {promptLength} chars
              </span>
            </div>
            <Textarea
              id="agent-studio-instructions"
              value={currentPrompt}
              onChange={(e) => editor.setOc('prompt', e.target.value)}
              placeholder="Tell your agent how to act, what guidelines to follow, and what tone to use..."
              rows={8}
              className="font-mono text-xs leading-relaxed"
            />
          </div>
        </div>
      </section>

      {/* ── 4. Core Capabilities (Superpowers) ── */}
      <section className="space-y-3">
        <div className="space-y-0.5">
          <h3 className="text-foreground text-sm font-medium">What superpowers does this agent have?</h3>
          <p className="text-muted-foreground text-xs">
            High-level permissions that govern what this agent is allowed to do.
          </p>
        </div>

        <div className="bg-popover divide-border/60 divide-y rounded-md border">
          <div className="flex items-center justify-between p-4">
            <div className="flex items-center gap-3">
              <span className="bg-kortix-blue/15 text-kortix-blue flex size-8 items-center justify-center rounded-sm">
                <GlobeIcon className="size-4" />
              </span>
              <div className="space-y-0.5">
                <div className="text-foreground text-xs font-medium">Web & Tool Integrations</div>
                <div className="text-muted-foreground text-xs">
                  Allows searching the web and connecting with external APIs and services.
                </div>
              </div>
            </div>
            <Switch
              checked={hasWebBrowsing}
              onCheckedChange={(checked) => {
                if (checked) {
                  editor.set('connectors', ['all']);
                } else {
                  editor.set('connectors', []);
                }
              }}
            />
          </div>

          <div className="flex items-center justify-between p-4">
            <div className="flex items-center gap-3">
              <span className="bg-kortix-green/15 text-kortix-green flex size-8 items-center justify-center rounded-sm">
                <CodeIcon className="size-4" />
              </span>
              <div className="space-y-0.5">
                <div className="text-foreground text-xs font-medium">Code & Sandbox Execution</div>
                <div className="text-muted-foreground text-xs">
                  Run terminal commands, write code files, and execute scripts in a secure sandbox.
                </div>
              </div>
            </div>
            <Switch
              checked={hasCodeExecution}
              onCheckedChange={(checked) => {
                editor.setOc('permission', checked ? 'allow' : 'deny');
              }}
            />
          </div>

          <div className="flex items-center justify-between p-4">
            <div className="flex items-center gap-3">
              <span className="bg-kortix-purple/15 text-kortix-purple flex size-8 items-center justify-center rounded-sm">
                <FolderIcon className="size-4" />
              </span>
              <div className="space-y-0.5">
                <div className="text-foreground text-xs font-medium">Workspace File Drives</div>
                <div className="text-muted-foreground text-xs">
                  Access persistent storage volumes and project files across sessions.
                </div>
              </div>
            </div>
            <Switch
              checked={hasDriveAccess}
              onCheckedChange={(checked) => {
                editor.set('repository_access', checked);
              }}
            />
          </div>
        </div>
      </section>

      {/* ── 5. Technical Tuning Callout ── */}
      <div className="bg-muted/40 border-border/60 flex items-center justify-between rounded-md border p-4">
        <div className="flex items-center gap-3">
          <WrenchIcon className="text-muted-foreground size-5 shrink-0" />
          <div className="space-y-0.5">
            <div className="text-foreground text-xs font-medium">Need deeper technical tuning?</div>
            <div className="text-muted-foreground text-xs">
              Configure fine-grained regex permission rules, custom Docker sandboxes, and raw YAML.
            </div>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={onOpenEngine} className="gap-1.5 shrink-0">
          <span>Open Engine Bay</span>
          <ArrowRightIcon className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}
