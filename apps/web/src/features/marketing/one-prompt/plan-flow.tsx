'use client';

import { cn } from '@kortix/ui';
import { Claude } from '@kortix/ui/internal/icons/claude';
import { OpenAI } from '@kortix/ui/internal/icons/open-ai';
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';

/** One terminal line: a command, plain output, a dimmed note or a success line. */
/** `wide`: shown from `sm` up; the phone shows the command, one instruction and the result. */
type Line = { kind: 'cmd' | 'out' | 'dim' | 'ok'; text: string; wide?: boolean };

/*
 * Art constants: each card wears its partner's own color, the one place on the
 * page with a full brand fill, so it reads at once as "your other tool". The
 * card is two parts split by one plain line: the stage, a deep brand shade at the top fading to the page background,
 * where the terminal stands and ends at the line; and the caption, on the
 * page background.
 */
const CLAUDE_ORANGE = '#D97757';
/** ChatGPT's purple. */
const CHATGPT_PURPLE = '#AB68FF';
/** The dark end of the stage gradient: the page's near-black. */
const STAGE_DARK = '#0A0A0B';
/** The stage runs from a deep shade of the brand color (45% color, 55% near-black) at the top to the page background at the bottom. */
const stage = (base: string) => `linear-gradient(to bottom, color-mix(in oklab, ${base} 45%, ${STAGE_DARK}), var(--background))`;
const BRANDS = {
  claude: { stage: stage(CLAUDE_ORANGE) },
  chatgpt: { stage: stage(CHATGPT_PURPLE) },
} as const;
/** The big watermark mark: turned white by the filter, then blended into the fill. */
const WATERMARK_FILTER = 'brightness(0) invert(1)';
/** A third-party mark sits on a white tile in both themes (color.md, logo tiles). */
const LOGO_TILE_BACKGROUND = '#FFFFFF';
/** The ink of a mark on that white tile. */
const LOGO_TILE_INK = '#000000';
/** The terminal: opaque near-black, the same on both fills. */
const TERMINAL_BACKGROUND = '#0A0A0B';
const TERMINAL_SHADOW = '0 0 0 1px rgb(255 255 255 / 0.10)';
/** The window dots: a faint white on the near-black glass. */
const DOT = 'rgb(255 255 255 / 0.16)';

/**
 * The two logins, as `kortix providers login` prints them
 * (apps/cli/src/commands/providers.ts). The device code is an example.
 */
const LOGINS: Array<{
  id: keyof typeof BRANDS;
  icon: ReactNode;
  /** The same mark at watermark size. */
  mark: ReactNode;
  name: string;
  lead: string;
  body: string;
  lines: Line[];
}> = [
  {
    id: 'claude',
    icon: <Claude className="size-5" />,
    mark: <Claude className="size-full" />,
    name: 'Claude',
    lead: 'Claude Pro or Max',
    body: 'Run Claude models through Claude Code.',
    lines: [
      { kind: 'cmd', text: 'kortix providers login claude' },
      { kind: 'out', text: 'Connect your Claude subscription' },
      { kind: 'dim', text: 'Open this URL, sign in with the Claude account that has your plan, and approve:', wide: true },
      { kind: 'dim', text: 'Then paste the code Claude shows you.', wide: true },
      { kind: 'out', text: 'Code from claude.com: ••••••••', wide: true },
      { kind: 'ok', text: 'Connected your Claude subscription' },
    ],
  },
  {
    id: 'chatgpt',
    icon: <OpenAI className="size-5" />,
    mark: <OpenAI className="size-full" />,
    name: 'ChatGPT',
    lead: 'ChatGPT Plus or Pro',
    body: 'Run GPT models on your subscription.',
    lines: [
      { kind: 'cmd', text: 'kortix providers login openai' },
      { kind: 'out', text: 'Authorize openai' },
      { kind: 'dim', text: 'Open this URL and enter the code:', wide: true },
      { kind: 'out', text: 'https://auth.openai.com/codex/device', wide: true },
      { kind: 'out', text: 'code: KX4F-92QD', wide: true },
      { kind: 'dim', text: 'Waiting for approval (Ctrl+C to cancel)…', wide: true },
      { kind: 'ok', text: 'Authorized openai on this workspace' },
    ],
  },
];

/** Each card types its lines in once it is a quarter in view: the command at once, then one line every LINE_MS. */
const LINE_MS = 250;

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';
function subscribeReducedMotion(onChange: () => void) {
  const query = window.matchMedia(REDUCED_MOTION);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

/** Terminal text: the card is a dark art pane in both themes, so the tokens read light on it. */
function TerminalLine({ line }: { line: Line }) {
  if (line.kind === 'cmd') {
    return (
      <p className="text-foreground flex gap-2 sm:text-sm">
        <span className="text-muted-foreground w-3 shrink-0">$</span>
        <span>{line.text}</span>
      </p>
    );
  }
  if (line.kind === 'ok') {
    return (
      <p className="text-foreground flex gap-2">
        <span className="text-kortix-green w-3 shrink-0">✓</span>
        <span>{line.text}</span>
      </p>
    );
  }
  return (
    <p className={cn('pl-5', line.kind === 'dim' ? 'text-muted-foreground' : 'text-foreground')}>
      {line.text}
    </p>
  );
}

/** One partner card: the stage with its terminal, a plain line, the caption. It types its own lines when it scrolls in. */
function LoginCard({ login, still }: { login: (typeof LOGINS)[number]; still: boolean }) {
  const root = useRef<HTMLElement>(null);
  const [shown, setShown] = useState(1);
  const visible = still ? login.lines.length : shown;

  useEffect(() => {
    const el = root.current;
    if (!el || still) return;
    let timer = 0;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        observer.disconnect();
        let count = 1;
        const next = () => {
          count += 1;
          setShown(count);
          if (count < login.lines.length) timer = window.setTimeout(next, LINE_MS);
        };
        timer = window.setTimeout(next, LINE_MS);
      },
      { threshold: 0.25 },
    );
    observer.observe(el);
    return () => {
      observer.disconnect();
      window.clearTimeout(timer);
    };
  }, [still, login.lines.length]);

  return (
    <figure ref={root} className="dark border-border relative isolate flex flex-col overflow-hidden rounded-xl border">
      {/* The stage: a deep-brand-to-page gradient, the mark as a watermark. The terminal stands on it and ends at the separator. */}
      <div style={{ background: BRANDS[login.id].stage }} className="relative isolate flex flex-1 flex-col overflow-hidden">
        {/* The mark: at the right edge, a quarter past it, centered on the top half of the stage. */}
        <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 -z-10 flex h-1/2 items-center justify-end">
          <span style={{ filter: WATERMARK_FILTER }} className="size-72 shrink-0 translate-x-1/4 opacity-10 mix-blend-overlay sm:size-80">
            {login.mark}
          </span>
        </span>
        <div className="flex items-center gap-3 px-6 pt-6 sm:px-8 sm:pt-8">
          <span
            style={{ background: LOGO_TILE_BACKGROUND, color: LOGO_TILE_INK }}
            className="inline-flex size-9 items-center justify-center rounded-lg shadow-sm"
          >
            {login.icon}
          </span>
          <span className="text-foreground text-base font-medium">
            {login.name}
          </span>
        </div>

        <div className="mt-8 flex flex-1 flex-col px-3 sm:px-8">
          <div
            style={{ background: TERMINAL_BACKGROUND, boxShadow: TERMINAL_SHADOW }}
            className="flex-1 rounded-t-lg"
          >
            <div aria-hidden className="flex items-center gap-1.5 px-4 py-3">
              <span style={{ background: DOT }} className="size-2.5 rounded-full" />
              <span style={{ background: DOT }} className="size-2.5 rounded-full" />
              <span style={{ background: DOT }} className="size-2.5 rounded-full" />
            </div>
            <div className="flex flex-col px-3 pt-1 pb-6 font-mono text-xs leading-6 sm:px-6">
              {login.lines.map((line, index) => (
                <div
                  key={index}
                  className={cn(
                    'duration-normal transition-opacity ease-out motion-reduce:transition-none',
                    index < visible ? 'opacity-100' : 'opacity-0',
                    line.kind === 'ok' && 'mt-3',
                    line.wide && 'hidden sm:block',
                  )}
                >
                  <TerminalLine line={line} />
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* The caption, on the page background, under one plain line. */}
      <figcaption
        className="bg-background border-border flex flex-col gap-2 border-t px-6 py-6 sm:px-8 sm:py-7"
      >
        <span className="text-foreground text-lg font-medium">{login.lead}</span>
        <span className="text-muted-foreground text-base text-pretty">
          {login.body}
        </span>
      </figcaption>
    </figure>
  );
}

/**
 * "Bring the plan you already pay for": two partner cards, Claude and ChatGPT,
 * each in its own brand color with its mark as a watermark. On the stage a Kortix terminal runs the
 * login and prints what the CLI prints; a plain line separates the caption,
 * which sits on the page background. Reduced motion shows the lines done.
 */
export function PlanFlow() {
  const still = useSyncExternalStore(
    subscribeReducedMotion,
    () => window.matchMedia(REDUCED_MOTION).matches,
    () => false,
  );
  return (
    <div className="mt-16 flex flex-col gap-6">
      <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-2">
        {LOGINS.map((login) => (
          <LoginCard key={login.id} login={login} still={still} />
        ))}
      </div>
      <p className="text-muted-foreground flex flex-col items-start gap-2 text-sm sm:flex-row sm:items-center sm:gap-3">
        Or any API key:
        <code className="border-border bg-card text-foreground rounded-md border px-2 py-1 font-mono text-xs">
          kortix providers set anthropic &quot;$KEY&quot;
        </code>
      </p>
    </div>
  );
}
