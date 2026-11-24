'use client';

import {
  BookOpenText,
  Briefcase,
  ChatCircleDots,
  EnvelopeSimple,
  GitPullRequest,
  GithubLogo,
  Palette,
  Receipt,
  Storefront,
  type Icon,
} from '@phosphor-icons/react';

import type { LoopView } from '@/features/marketing/one-prompt/loops-content';
import { SCENES, type Scene } from '@/features/marketing/one-prompt/scenes';
import type { UseCaseGroup, UseCaseView } from '@/features/marketing/one-prompt/use-cases-content';

/** The workspace every card sits in. Synthetic name, like the role cards. */
const WORKSPACE = 'your-company';

/** What one card shows: the signal, the agent's run and the work it returned. */
export interface SessionView {
  id: string;
  icon: Icon;
  /** The system the signal arrived from, as the card's title. */
  source: string;
  /** The primary agent of the role, from the template. */
  agent: string;
  /** `real`: the demo run shipped with this build. `example`: the role's steps. */
  kind: Scene['kind'];
  signal: string;
  steps: number;
  /** One sentence on what the agent did, in past tense. */
  summary: string;
  ship: Scene['ship'];
}

/** What each role's run is called in one sentence. The steps live in `SCENES`. */
const SUMMARY: Record<string, string> = {
  'software-factory': 'Read the issue, reproduced the crash on main, and opened the fix with the test that proves it.',
  marketing: 'Wrote the changelog entry from the merge, drafted the post and cut the clip for review.',
  sales: 'Researched the company, scored it against your ideal customer and drafted the first message.',
  support: 'Found the bug behind the report, drafted the reply and filed the ticket for engineering.',
  recruiting: 'Read the application and the links, scored the candidate against the role and built the interview kit.',
};

/**
 * The finance card has no starter template yet, so it stays an example: the
 * work the same prompt sets up when you describe the loop yourself.
 */
const FINANCE: SessionView = {
  id: 'finance',
  icon: Receipt,
  source: 'Schedule · 1st of the month',
  agent: 'finance',
  kind: 'example',
  signal: 'Vendor invoices due · 15 accounts',
  steps: 3,
  summary: 'Filed 14 invoices in accounting and flagged the one account that needs your login.',
  ship: { kind: 'Filing', title: '14 invoices filed, 1 account needs you', status: 'Waiting for your approval' },
};

/** The icon for a role's signal, by where it arrives. */
const ICON: Record<string, Icon> = {
  'software-factory': GithubLogo,
  marketing: GitPullRequest,
  sales: EnvelopeSimple,
  support: ChatCircleDots,
  recruiting: Briefcase,
};

/** One glyph per audience for the described roles. */
const GROUP_ICON: Record<UseCaseGroup, Icon> = {
  'Run a store': Storefront,
  'Professional work': Briefcase,
  'Creative work': Palette,
  'Learn and plan': BookOpenText,
};

/**
 * The cards the hero carousel shows, in stack order. Template cards read the
 * build's own scene data. Described roles read the use-case catalog and are
 * always marked as examples, so a card cannot claim work the templates do not
 * ship.
 */
export function sessionViews(roles: LoopView[], useCases: readonly UseCaseView[] = []): SessionView[] {
  const cards = roles.flatMap((role): SessionView[] => {
    const scene = SCENES[role.id];
    const icon = ICON[role.id];
    const summary = SUMMARY[role.id];
    if (!scene || !icon || !summary) return [];
    return [
      {
        id: role.id,
        icon,
        source: scene.signal.source,
        agent: role.agent,
        kind: scene.kind,
        signal: scene.signal.title,
        steps: scene.steps.length,
        summary,
        ship: scene.ship,
      },
    ];
  });
  const examples: SessionView[] = useCases.map((useCase) => ({
    id: useCase.id,
    icon: GROUP_ICON[useCase.group],
    source: useCase.source,
    agent: useCase.id,
    kind: 'example',
    signal: useCase.signal,
    steps: useCase.steps.length,
    summary: useCase.line,
    ship: { kind: 'Draft', title: useCase.result, status: 'Waiting for your approval' },
  }));
  // The finance placeholder is only for the strip without the wider catalog:
  // bookkeeping is already covered once `useCases` is passed.
  const extra = useCases.length === 0 && !roles.some((role) => role.id === 'finance') ? [FINANCE] : [];
  return [...cards, ...examples, ...extra];
}

/** A 5x5 mirrored identicon from the agent name: deterministic, no image. */
function identicon(name: string): boolean[] {
  let hash = 2166136261;
  for (let i = 0; i < name.length; i += 1) {
    hash ^= name.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const cells: boolean[] = [];
  for (let y = 0; y < 5; y += 1) {
    for (let x = 0; x < 3; x += 1) {
      const on = ((hash >>> ((y * 3 + x) % 31)) & 1) === 1;
      cells[y * 5 + x] = on;
      cells[y * 5 + (4 - x)] = on;
    }
  }
  return cells;
}

function AgentTile({ name }: { name: string }) {
  return (
    <span aria-hidden className="bg-muted inline-flex size-5 shrink-0 items-center justify-center rounded-sm">
      <svg viewBox="0 0 5 5" shapeRendering="crispEdges" className="fill-foreground size-3.5">
        {identicon(name).map((on, index) =>
          on ? <rect key={index} x={index % 5} y={Math.floor(index / 5)} width={1} height={1} /> : null,
        )}
      </svg>
    </span>
  );
}

/**
 * One agent run, drawn as the conversation it was: where the signal came from,
 * the request, the steps the agent worked through, and the result waiting for
 * a person. No live timer here: the whole strip moves, so a per-card clock
 * would be six animations the reader never finishes reading.
 */
export function SessionCard({ view }: { view: SessionView }) {
  const Icon = view.icon;
  return (
    <article className="border-border bg-card flex h-[420px] w-[min(84vw,400px)] shrink-0 flex-col overflow-hidden rounded-xl border">
      <div className="border-border flex h-11 shrink-0 items-center gap-2.5 border-b px-4">
        <Icon aria-hidden className="text-muted-foreground size-4 shrink-0" />
        <span className="text-foreground min-w-0 truncate text-sm font-medium">{view.source}</span>
        <span className="ml-auto flex shrink-0 items-center gap-2">
          <AgentTile name={view.agent} />
          <span className="text-muted-foreground text-sm">{view.agent}</span>
        </span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-4 px-4 pt-4 pb-6">
        <div className="flex flex-col items-end gap-2">
          <p className="bg-muted text-foreground ml-8 rounded-lg px-3 py-2.5 text-sm">
            <span className="line-clamp-3">{view.signal}</span>
          </p>
          <span className="text-muted-foreground text-xs">
            <span className="text-foreground">{WORKSPACE}</span> added to context
          </span>
        </div>
        <div className="flex flex-col gap-2">
          <span className="text-muted-foreground flex items-center gap-1.5 text-sm">
            Worked through {view.steps} steps
            <span aria-hidden>{'\u203a'}</span>
          </span>
          <p className="text-foreground text-sm text-pretty">{view.summary}</p>
        </div>
        <div className="border-border mt-auto flex flex-col gap-1 rounded-lg border px-3 py-2.5">
          <span className="text-muted-foreground flex items-baseline justify-between gap-2 font-mono text-xs">
            <span className="truncate">{view.ship.kind}</span>
            <span className="shrink-0">{view.kind === 'real' ? 'real run' : 'example'}</span>
          </span>
          <span className="text-foreground line-clamp-2 text-sm font-medium">{view.ship.title}</span>
          <span className="text-muted-foreground inline-flex items-center gap-1.5 text-xs">
            <span aria-hidden className="bg-kortix-base size-1.5 rounded-full" />
            {view.ship.status}
          </span>
        </div>
      </div>
    </article>
  );
}
