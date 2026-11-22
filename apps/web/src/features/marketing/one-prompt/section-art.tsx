'use client';

import { AgentMarkGlyph, agentMarkTileClass, agentMarkVars } from '@kortix/ui/internal/components/agent-mark';
import { Claude } from '@kortix/ui/internal/icons/claude';
import { cn } from '@kortix/ui';
import { ArrowUpIcon, CaretDownIcon, CheckIcon, PaperclipIcon } from '@phosphor-icons/react';
import { useEffect, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react';

import { DEMO } from './factory-content';

/**
 * The small product views the sections show. Static, drawn from tokens, with
 * the data of the demo run where there is one. They are art: hidden from
 * assistive tech, the cell's title and text carry the meaning.
 */

const dot = (on: boolean) => <span className={cn('size-1.5 rounded-full', on ? 'bg-kortix-base' : 'bg-muted-foreground')} />;

/** The marks in `public/connector-icons/` that the step cards show. */
type ToolSlug =
  | 'airtable' | 'asana' | 'canva' | 'cloudflare' | 'discord' | 'dropbox' | 'figma' | 'github' | 'gmail' | 'google_calendar'
  | 'google_docs' | 'google_drive' | 'google_sheets' | 'hubspot' | 'intercom' | 'linear' | 'notion' | 'paypal' | 'posthog'
  | 'sentry' | 'slack' | 'stripe' | 'supabase' | 'teams' | 'telegram' | 'vercel' | 'webflow';

/** A tool's official mark: the same tiles the connector screens use (`public/connector-icons/`). */
function ToolIcon({ slug }: { slug: ToolSlug }) {
  // eslint-disable-next-line @next/next/no-img-element -- a 20px static SVG tile; next/image adds nothing here
  return <img src={`/connector-icons/${slug}.svg`} alt="" width={20} height={20} loading="lazy" decoding="async" className="size-5 rounded-sm" />;
}

/** An agent's pixel mark in its tile, without the hover hint: art carries no tooltip. */
export function AgentTile({ slug, size = 14 }: { slug: string; size?: 14 | 21 }) {
  const tile = size === 21 ? 28 : 20;
  return (
    <span
      aria-hidden
      style={{ ...agentMarkVars(slug), width: tile, height: tile }}
      className={cn('inline-flex shrink-0 items-center justify-center bg-(--mark-tile)', size === 21 ? 'rounded-md' : 'rounded-sm', agentMarkTileClass(slug))}
    >
      <AgentMarkGlyph slug={slug} size={size} />
    </span>
  );
}

/** Rows that scroll without end: drawn twice, so moving by half lands on the start (`kx-ticker` in globals.css). */
function Loop({ axis = 'y', seconds, reverse, className, children }: { axis?: 'x' | 'y'; seconds: number; reverse?: boolean; className?: string; children: ReactNode }) {
  return (
    <div
      className={cn(axis === 'y' ? 'kx-ticker' : 'kx-ticker-x flex w-max', className)}
      style={{ '--ticker-duration': `${seconds}s`, animationDirection: reverse ? 'reverse' : undefined } as CSSProperties}
    >
      {children}
      {children}
    </div>
  );
}

/** Where the scan found each tool: the file and the match in it. The ones it cannot see, it asks about. */
const FOUND: ReadonlyArray<{ slug: ToolSlug; where: string; match: string }> = [
  { slug: 'github', where: '.github/workflows/ci.yml', match: 'actions/checkout' },
  { slug: 'sentry', where: 'package.json', match: '@sentry/node' },
  { slug: 'stripe', where: '.env.example', match: 'STRIPE_SECRET_KEY' },
  { slug: 'slack', where: 'src/notify.ts', match: 'SLACK_WEBHOOK_URL' },
  { slug: 'supabase', where: 'supabase/config.toml', match: 'project_id' },
  { slug: 'vercel', where: 'vercel.json', match: 'buildCommand' },
  { slug: 'posthog', where: 'package.json', match: 'posthog-js' },
  { slug: 'intercom', where: 'src/widget.tsx', match: 'intercom-client' },
  { slug: 'cloudflare', where: 'wrangler.toml', match: 'account_id' },
  { slug: 'notion', where: 'README.md', match: 'notion.so/runbook' },
  { slug: 'figma', where: 'docs/design.md', match: 'figma.com/file' },
  { slug: 'discord', where: '.env.example', match: 'DISCORD_BOT_TOKEN' },
  { slug: 'paypal', where: 'package.json', match: '@paypal/checkout' },
];

/** The apps the connect step reaches, as two rows of tiles that move past each other. */
const APPS_TOP: ReadonlyArray<ToolSlug> = ['github', 'slack', 'stripe', 'linear', 'gmail', 'notion', 'hubspot', 'intercom', 'google_drive'];
const APPS_BOTTOM: ReadonlyArray<ToolSlug> = ['sentry', 'teams', 'asana', 'google_sheets', 'airtable', 'dropbox', 'google_calendar', 'figma', 'supabase'];

/** What starts an agent: app events, messages, schedules. `when` is how long ago it fired. */
const SIGNALS: ReadonlyArray<{ slug?: ToolSlug; name: string; when: string }> = [
  { slug: 'github', name: 'Issue opened', when: 'now' },
  { name: 'Every night at 02:00', when: '2m' },
  { slug: 'sentry', name: 'New error in production', when: '4m' },
  { slug: 'stripe', name: 'Payment failed', when: '9m' },
  { slug: 'slack', name: '@engineer in #eng', when: '12m' },
  { slug: 'intercom', name: 'Customer asks for a refund', when: '18m' },
  { slug: 'hubspot', name: 'Deal moved to Won', when: '25m' },
  { slug: 'gmail', name: 'Email from a customer', when: '31m' },
  { slug: 'posthog', name: 'New signup', when: '40m' },
  { slug: 'vercel', name: 'Deploy failed', when: '52m' },
  { slug: 'google_calendar', name: 'Sales call ended', when: '1h' },
  { slug: 'webflow', name: 'Form submitted', when: '1h' },
];

/** Runs the agents finished: the steps each took and what it left for a person. */
const RUNS: ReadonlyArray<{ agent: string; loop: string; steps: string[]; result: string }> = [
  { agent: 'engineer', loop: 'nightly-tests', steps: ['Ran 412 tests on main', 'Reproduced 3 failures', 'Filed 3 issues with the request'], result: '3 bugs filed' },
  { agent: 'engineer', loop: 'fix #6', steps: ['Reproduced the crash', 'Fixed the parser', 'Tests pass on the branch'], result: 'Pull request waits for you' },
  { agent: 'support', loop: 'refunds', steps: ['Read the conversation', 'Checked the order in Stripe', 'Drafted the reply'], result: 'Refund waits for you' },
  { agent: 'sales', loop: 'new-signups', steps: ['Researched 9 companies', 'Scored each against your ICP', 'Drafted the outreach'], result: '9 drafts wait for you' },
];

/** One beat of the run card: a step appears, the result appears, the card holds, the next run comes in. */
const RUN_BEAT_MS = 900;

/** Step 1: the scan as it runs in your terminal: the file, the match, the tool it means. Then a question. */
export function FindArt() {
  return (
    <div className="border-border bg-background w-full max-w-sm min-w-0 overflow-hidden rounded-xl border font-mono text-xs shadow-xl shadow-black/15">
      <div className="border-border text-muted-foreground flex items-center gap-2 border-b px-3 py-2">
        <Claude className="size-3.5 shrink-0" />
        <span className="truncate">Scanning your-org/your-repo</span>
      </div>
      <div className="group/ticker h-44 overflow-hidden px-3 [mask-image:linear-gradient(to_bottom,transparent,#000_15%,#000_85%,transparent)]">
        <Loop seconds={30}>
          {FOUND.map((found) => (
            <div key={found.where + found.match} className="flex items-center gap-2 py-1.5">
              <ToolIcon slug={found.slug} />
              <span className="text-muted-foreground min-w-0 flex-1 truncate">{found.where}</span>
              <span className="text-foreground shrink-0">{found.match}</span>
            </div>
          ))}
        </Loop>
      </div>
      <div className="border-border border-t px-3 py-2.5">
        <span className="text-foreground">? Which helpdesk do you use?</span>
        <span aria-hidden className="bg-foreground ml-1 inline-block h-3 w-1.5 animate-pulse align-middle motion-reduce:animate-none" />
      </div>
    </div>
  );
}

/** Step 2: the apps in two rows that move past each other, and what the setup stored. */
export function ConnectArt() {
  const tile = (slug: ToolSlug) => (
    <span key={slug} className="border-border bg-card mr-3 flex size-12 shrink-0 items-center justify-center rounded-xl border">
      <ToolIcon slug={slug} />
    </span>
  );
  return (
    <div className="group/ticker flex w-full min-w-0 flex-col items-center gap-6">
      <div className="w-full overflow-hidden [mask-image:linear-gradient(to_right,transparent,#000_15%,#000_85%,transparent)]">
        <Loop axis="x" seconds={34}>{APPS_TOP.map(tile)}</Loop>
        <Loop axis="x" seconds={40} reverse className="mt-3">{APPS_BOTTOM.map(tile)}</Loop>
      </div>
      <div className="border-border bg-card flex items-center gap-3 rounded-full border px-4 py-2 text-xs shadow-xl shadow-black/15">
        <span className="text-foreground">3,000+ apps</span>
        <span className="bg-border h-3 w-px" />
        <span className="text-muted-foreground font-mono">SENTRY_DSN ••••••</span>
        <span className="text-muted-foreground">encrypted</span>
      </div>
    </div>
  );
}

/** Step 3: events as they arrive, a stream of pills, each one a signal an agent listens to. */
export function SignalArt() {
  return (
    <div className="group/ticker h-60 w-full max-w-sm min-w-0 overflow-hidden [mask-image:linear-gradient(to_bottom,transparent,#000_20%,#000_80%,transparent)]">
      <Loop seconds={36} reverse>
        {SIGNALS.map((signal, index) => (
          <div key={signal.name} className={cn('flex py-1.5', index % 2 ? 'justify-end' : 'justify-start')}>
            <span className="border-border bg-card inline-flex max-w-full items-center gap-2 rounded-full border py-1.5 pr-3 pl-1.5 text-sm">
              {signal.slug ? <ToolIcon slug={signal.slug} /> : <span className="bg-muted flex size-5 items-center justify-center rounded-full">{dot(true)}</span>}
              <span className="text-foreground truncate">{signal.name}</span>
              <span className="text-muted-foreground shrink-0 text-xs">{signal.when}</span>
            </span>
          </div>
        ))}
      </Loop>
    </div>
  );
}

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';
function subscribeReducedMotion(onChange: () => void) {
  const query = window.matchMedia(REDUCED_MOTION);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

/**
 * Step 4: one run plays out a step at a time, ends on what waits for a
 * person, then the next run takes its place. Under it, the Kortix MCP server
 * the setup added to your coding agent. Reduced motion shows the first run, done.
 */
export function ProveArt() {
  const still = useSyncExternalStore(subscribeReducedMotion, () => window.matchMedia(REDUCED_MOTION).matches, () => false);
  const [ticks, setTicks] = useState(0);
  useEffect(() => {
    if (still) return;
    const id = setInterval(() => setTicks((value) => value + 1), RUN_BEAT_MS);
    return () => clearInterval(id);
  }, [still]);
  const beat = still ? RUNS[0]!.steps.length + 1 : ticks;
  // A run lasts its steps, the result, then three beats of hold.
  const length = (run: (typeof RUNS)[number]) => run.steps.length + 4;
  let at = beat % RUNS.reduce((sum, run) => sum + length(run), 0);
  let index = 0;
  while (at >= length(RUNS[index]!)) {
    at -= length(RUNS[index]!);
    index += 1;
  }
  const run = RUNS[index]!;
  const done = at > run.steps.length;
  return (
    <div className="flex w-full max-w-sm min-w-0 flex-col gap-3">
      <div key={run.loop} className="border-border bg-card animate-in fade-in duration-slow rounded-xl border p-3 shadow-xl shadow-black/15">
        <div className="flex items-center gap-2.5">
          <AgentTile slug={run.agent} />
          <span className="text-foreground min-w-0 flex-1 truncate font-mono text-sm">{run.loop}</span>
          <span className={cn('text-xs', done ? 'text-foreground' : 'text-muted-foreground')}>{done ? 'Finished' : 'Running'}</span>
        </div>
        <ol className="mt-3 flex flex-col gap-2">
          {run.steps.map((step, stepIndex) => (
            <li key={step} className={cn('duration-normal flex items-center gap-2.5 text-sm transition-opacity', stepIndex < at ? 'opacity-100' : 'opacity-0')}>
              <CheckIcon className="text-foreground size-3.5 shrink-0" />
              <span className="text-muted-foreground truncate">{step}</span>
            </li>
          ))}
        </ol>
        <div className={cn('border-border duration-normal mt-3 border-t pt-3 text-sm transition-opacity', done ? 'opacity-100' : 'opacity-0')}>
          <span className="text-foreground">{run.result}</span>
        </div>
      </div>
      <div className="border-border bg-card text-muted-foreground ml-8 flex items-center gap-2 rounded-lg border px-3 py-2 text-xs">
        <Claude className="size-3.5 shrink-0" />
        <span className="truncate">Kortix MCP server added to Claude Code</span>
      </div>
    </div>
  );
}

/**
 * The Kortix chat input: the message, then one row of attach, the agent
 * picker, space, send. `light` is the input on a light card.
 */
export function ChatComposer({
  text,
  agent,
  tone = 'dark',
  busy = false,
  className,
}: {
  /** The typed message; empty shows the "Reply…" placeholder. */
  text?: string;
  agent: string;
  tone?: 'dark' | 'light';
  /** The agent is working: send turns into stop. */
  busy?: boolean;
  className?: string;
}) {
  const light = tone === 'light';
  return (
    <div
      className={cn(
        'flex w-full min-w-0 flex-col gap-3 rounded-xl border p-2.5',
        light ? 'border-background/10 bg-background/5 text-background' : 'border-border bg-card text-foreground',
        className,
      )}
    >
      <span className={cn('min-h-10 px-1 pt-0.5 text-sm', !text && (light ? 'text-background/50' : 'text-muted-foreground'))}>{text || 'Reply…'}</span>
      <div className={cn('flex items-center gap-1', light ? 'text-background/60' : 'text-muted-foreground')}>
        <span className="inline-flex size-7 items-center justify-center rounded-md">
          <PaperclipIcon className="size-4" />
        </span>
        <span className={cn('inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs', light ? 'bg-background/5' : 'bg-muted/60')}>
          <AgentTile slug={agent} />
          <span className={light ? 'text-background' : 'text-foreground'}>{agent}</span>
          <CaretDownIcon className="size-3" />
        </span>
        <span
          className={cn(
            'ml-auto inline-flex size-7 items-center justify-center rounded-full',
            light ? 'bg-background text-foreground' : busy ? 'bg-foreground text-background' : 'bg-accent text-muted-foreground',
          )}
        >
          {busy ? <span className="size-2 rounded-xs bg-current" /> : <ArrowUpIcon className="size-3.5" />}
        </span>
      </div>
    </div>
  );
}

/** A card-sized composer with a message in it. */
export function ComposerArt({ text, agent, tone = 'dark' }: { text: string; agent: string; tone?: 'dark' | 'light' }) {
  return <ChatComposer text={text} agent={agent} tone={tone} className={cn('max-w-sm', tone === 'dark' && 'shadow-xl shadow-black/15')} />;
}

function Approval({ slug, title, status, time, className }: { slug: string; title: string; status: string; time: string; className?: string }) {
  return (
    <div className={cn('border-border bg-card flex items-center gap-3 rounded-xl border p-3 shadow-xl shadow-black/15', className)}>
      <AgentTile slug={slug} size={21} />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-foreground truncate text-sm font-medium">{title}</span>
        <span className="text-muted-foreground truncate text-xs">{status}</span>
      </div>
      <span className="text-muted-foreground shrink-0 text-xs">{time}</span>
    </div>
  );
}

/** What waits for a person: the pull request from the demo run, and a deploy as an example. */
export function ApprovalArt() {
  return (
    <div className="flex w-full max-w-sm min-w-0 flex-col gap-2">
      <Approval slug="engineer" title={`Pull request #${DEMO.pr.number}`} status="Waiting for you to merge" time="now" />
      <Approval slug="engineer" title="Deploy to production" status="Waiting for your approval" time="2m" className="opacity-70" />
    </div>
  );
}
