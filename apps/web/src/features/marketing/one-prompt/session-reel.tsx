'use client';

import { FULL_COLOR_LOGOS } from '@/features/marketing/landing-sections/works-with-logos';
import { ChainOfThought } from '@kortix/ui/chain-of-thought';
import { Disclosure, DisclosureContent, DisclosureTrigger } from '@kortix/ui/disclosure';
import { Claude } from '@kortix/ui/internal/icons/claude';
import { TextShimmer } from '@kortix/ui/text-shimmer';
import { cn } from '@kortix/ui';
import { ArrowLeftIcon, ArrowRightIcon, CaretRightIcon, ClockIcon, LightningIcon, TerminalWindowIcon } from '@phosphor-icons/react';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';

import { sessionPool } from './agent-sessions';
import type { HeroRun } from './hero-runs';
import { AgentTile } from './section-art';

/** A horizontal trackpad swipe this long (px of `deltaX`) moves the reel one session. */
const SWIPE_PX = 40;
/** After a swipe moves the reel, the rest of that gesture's momentum is ignored for this long. */
const SWIPE_COOLDOWN_MS = 700;

/**
 * How long each beat of a session lasts: the message, the context, the agent
 * working, the answer, the result, then a hold before the panel starts its next session.
 */
const BEATS_MS = [700, 700, 1800, 700, 800, 3600];
const LAST_BEAT = BEATS_MS.length;
/** The reel moves one panel on this often. Every panel plays its own sessions meanwhile. */
const SLIDE_EVERY_MS = 4500;
/** Panels start their first session this far apart, so they never all move at once. */
const STAGGER_MS = 900;
/**
 * Only the panels near the reel's left edge are drawn: from one before it to
 * seven after (a 2560 px screen shows about six). Every other slot is an
 * empty box of the same width, so the track keeps its geometry with a
 * fraction of the DOM, and only drawn panels run their clocks.
 */
const DRAW_BEFORE = 1;
const DRAW_AFTER = 7;
// DRAW_BEFORE + DRAW_AFTER + 1 must stay below the number of runs, or two copies of one run would need drawing.

/** Panel width and the gap between panels. The track moves by their sum. */
const PANEL = 'min(84vw, 400px)';
/** The slide's length: `duration-slower` on the track. The reel settles after it. */
const SLIDE_MS = 500;
const GAP = '16px';

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';
const prefersReducedMotion = () => window.matchMedia(REDUCED_MOTION).matches;
function subscribeReducedMotion(onChange: () => void) {
  const query = window.matchMedia(REDUCED_MOTION);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

/**
 * The hero reel: agent sessions side by side, every one of them live. Each
 * panel plays a session (the message arrives, the agent works, the result
 * lands), then picks another of its agent's sessions at random, without end.
 * The reel moves one panel on every few seconds. It loops without end (the list is drawn three
 * times and the track jumps back to the middle copy after each slide). It pauses on hover,
 * on focus and off screen. Reduced motion shows every session finished and
 * moves only when the arrows are used.
 */
export function SessionReel({ runs }: { runs: HeroRun[] }) {
  const count = runs.length;
  const root = useRef<HTMLDivElement>(null);
  const still = useSyncExternalStore(subscribeReducedMotion, prefersReducedMotion, () => false);
  // `pos` indexes the tripled list; the middle copy starts at `count`.
  const [pos, setPos] = useState(count);
  const [animate, setAnimate] = useState(true);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [visible, setVisible] = useState(false);
  // After the first arrow press the reader drives the reel: autoplay stops for good. Touch has
  // no hover and a tap does not focus, so this is the pause that works everywhere (WCAG 2.2.2).
  const [driven, setDriven] = useState(false);
  const active = ((pos % count) + count) % count;
  const run = runs[active]!;
  const caption = run.kind === 'example' ? `${run.caption} · example` : run.caption;

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const observer = new IntersectionObserver(([entry]) => setVisible(entry?.isIntersecting ?? false), { threshold: 0.3 });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // A sideways trackpad swipe moves the reel, as the arrows do. Vertical scrolling passes through
  // to the page. A native listener, because React's wheel handler is passive and cannot stop the
  // browser's back-swipe.
  const goRef = useRef<(step: number, manual?: boolean) => void>(() => {});
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    let travel = 0;
    let lockedUntil = 0;
    const onWheel = (event: WheelEvent) => {
      if (Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return;
      event.preventDefault();
      const now = performance.now();
      if (now < lockedUntil) return;
      travel += event.deltaX;
      if (Math.abs(travel) < SWIPE_PX) return;
      goRef.current(travel > 0 ? 1 : -1, true);
      travel = 0;
      lockedUntil = now + SWIPE_COOLDOWN_MS;
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // The middle copy holds `pos` between moves. A move may step one panel outside it; the
  // reel then settles back before it accepts the next move, so `pos` never leaves the buffer.
  const outside = pos < count || pos >= 2 * count;
  const posRef = useRef(pos);
  useEffect(() => {
    posRef.current = pos;
  }, [pos]);
  const go = useCallback(
    (step: number, manual = false) => {
      const current = posRef.current;
      // A press always takes control, even when its move is dropped below.
      if (manual) setDriven(true);
      // Mid-settle: drop the move rather than push `pos` out of the buffer.
      if (!still && (current < count || current >= 2 * count)) return;
      if (still) {
        // Reduced motion has no slide to wait for: land in the middle copy at once.
        setPos(count + ((((current + step) % count) + count) % count));
        return;
      }
      setAnimate(true);
      setPos(current + step);
    },
    [still, count],
  );
  useEffect(() => {
    goRef.current = go;
  }, [go]);

  // Move one panel on at a steady pace; the panels play on their own.
  useEffect(() => {
    if (still || driven || hovered || focused || !visible) return;
    const id = setInterval(() => go(1), SLIDE_EVERY_MS);
    return () => clearInterval(id);
  }, [still, driven, hovered, focused, visible, go]);

  // After a slide ends outside the middle copy, jump back into it with no animation.
  // A timer, not `transitionend`: that event does not fire in a hidden tab.
  useEffect(() => {
    if (!outside) return;
    const id = setTimeout(() => {
      setAnimate(false);
      setPos(count + active);
    }, SLIDE_MS);
    return () => clearTimeout(id);
  }, [outside, count, active]);
  // Two frames: the first paints the jump with no transition, the second turns it back on.
  useEffect(() => {
    if (animate) return;
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => setAnimate(true));
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, [animate]);

  const track: CSSProperties = {
    gap: GAP,
    transform: `translate3d(calc(-${pos} * (${PANEL} + ${GAP})), 0, 0)`,
  };

  return (
    <div
      ref={root}
      role="region"
      aria-roledescription="carousel"
      aria-label="Agent sessions"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      // Focus moving between the two arrows stays inside: only leaving the reel resumes it.
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
      }}
      className="flex flex-col gap-8"
    >
      <div
        style={track}
        className={cn(
          'flex',
          // A large element crossing the page: the marketing duration, the house curve.
          animate && !still && 'ease-default transition-transform duration-slower',
        )}
      >
        {runs.map((item, index) => (
          <RunPanels
            key={item.id}
            run={item}
            index={index}
            count={count}
            pos={pos}
            live={visible}
            still={still}
            instant={!animate || still}
          />
        ))}
      </div>

      <div className="flex items-center justify-between gap-6">
        <p aria-hidden={still || driven} className="text-muted-foreground font-mono text-xs tracking-wider uppercase">
          <span key={run.id} className="animate-in fade-in duration-slow">
            {caption}
          </span>
        </p>
        {/* Announce only what the reader chose: a caption that changes on its own every few seconds is noise.
            The region is always mounted, so the first arrow press is announced too. */}
        <span aria-live="polite" className="sr-only">
          {still || driven ? caption : ''}
        </span>
        <div className="flex items-center gap-1">
          <ReelArrow label="Previous session" onClick={() => go(-1, true)}>
            <ArrowLeftIcon className="size-4" />
          </ReelArrow>
          <ReelArrow label="Next session" onClick={() => go(1, true)}>
            <ArrowRightIcon className="size-4" />
          </ReelArrow>
        </div>
      </div>
    </div>
  );
}

function ReelArrow({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="text-muted-foreground hover:text-foreground hover:bg-accent hit-area-1 inline-flex size-9 items-center justify-center rounded-md transition-colors"
    >
      {children}
    </button>
  );
}

/** A beat's content: mounted from the first frame, faded in when its beat arrives, so the panel never jumps. */
function Beat({ at, beat, instant, className, children }: { at: number; beat: number; instant: boolean; className?: string; children: React.ReactNode }) {
  return (
    <div aria-hidden={beat < at} className={cn(!instant && 'transition-opacity duration-slower ease-out', beat >= at ? 'opacity-100' : 'opacity-0', className)}>
      {children}
    </div>
  );
}

/**
 * "Worked through N steps": the session chat's work fold. Closed, it is one
 * quiet line over the answer; open, a hairline under it, then the steps.
 */
function WorkFold({ run, working }: { run: HeroRun; working: boolean }) {
  if (working) {
    return (
      <TextShimmer className="text-sm [--base-color:color-mix(in_oklch,var(--muted-foreground)_55%,transparent)] [--base-gradient-color:var(--muted-foreground)] dark:[--base-color:color-mix(in_oklch,var(--muted-foreground)_55%,transparent)] dark:[--base-gradient-color:var(--muted-foreground)]">
        Working
      </TextShimmer>
    );
  }
  return (
    <Disclosure className="group/work flex-col">
      <DisclosureTrigger className="select-none">
        <div className="text-muted-foreground hover:text-foreground group-data-[state=open]/work:border-border flex w-full cursor-pointer items-center gap-2 text-left text-sm transition-colors group-data-[state=open]/work:border-b group-data-[state=open]/work:pb-2">
          <span className="min-w-0 truncate tabular-nums">Worked through {run.work.length} steps</span>
          <CaretRightIcon aria-hidden className="size-3.5 flex-none transition-transform group-data-[state=open]/work:rotate-90" />
        </div>
      </DisclosureTrigger>
      <DisclosureContent>
        <ChainOfThought className="mt-3 space-y-2">
          {run.work.map((step, index) => (
            <div key={index} className="flex items-baseline gap-2.5 text-sm">
              <span aria-hidden className="bg-muted-foreground/40 relative top-[-2px] size-1.5 shrink-0 rounded-full" />
              <span className={cn('min-w-0', step.cmd ? 'text-foreground font-mono text-xs' : 'text-muted-foreground')}>{step.cmd ? `$ ${step.text}` : step.text}</span>
            </div>
          ))}
        </ChainOfThought>
      </DisclosureContent>
    </Disclosure>
  );
}

/** Where one run's panel stands: the session it plays and its beat. */
type Play = { run: HeroRun; beat: number; round: number; working: boolean };

/**
 * One run's clock. It plays the run's sessions beat by beat and, when one
 * ends, picks another at random, never the same twice in a row. It holds
 * while the reader points at or types into the panel.
 */
function useRunPlay(first: HeroRun, live: boolean, delay: number, still: boolean) {
  const pool = useMemo(() => sessionPool(first), [first]);
  const [index, setIndex] = useState(0);
  const [round, setRound] = useState(0);
  // The first session renders finished, so nothing builds up on load; the next ones play beat by beat.
  const [beat, setBeat] = useState(LAST_BEAT);
  const [held, setHeld] = useState(false);
  const playing = live && !still && !held;

  useEffect(() => {
    if (!playing) return;
    const hold = BEATS_MS[Math.min(beat, LAST_BEAT - 1)]!;
    const wait = round === 0 && beat === LAST_BEAT ? delay + hold : hold;
    const id = setTimeout(() => {
      if (beat < LAST_BEAT) {
        setBeat(beat + 1);
        return;
      }
      setIndex(pool.length < 2 ? 0 : (index + 1 + Math.floor(Math.random() * (pool.length - 1))) % pool.length);
      setRound((value) => value + 1);
      setBeat(0);
    }, wait);
    return () => clearTimeout(id);
  }, [playing, beat, round, delay, index, pool.length]);

  const play: Play = {
    run: pool[index] ?? first,
    beat: still ? LAST_BEAT : beat,
    round,
    working: playing && beat === 2,
  };
  return {
    play,
    hold: setHeld,
  };
}

/**
 * One run, drawn three times (once per copy of the list): one clock, so the
 * copies always show the same moment and the jump back to the middle copy
 * never changes what the reader sees. Flex `order` puts each copy in its slot.
 */
function RunPanels({ run, index, count, pos, live, still, instant }: { run: HeroRun; index: number; count: number; pos: number; live: boolean; still: boolean; instant: boolean }) {
  const slots = [0, 1, 2].map((copy) => copy * count + index);
  const drawn = (slot: number) => slot >= pos - DRAW_BEFORE && slot <= pos + DRAW_AFTER;
  // The clock runs only while one of the run's copies is drawn.
  const { play, hold } = useRunPlay(run, live && slots.some(drawn), index * STAGGER_MS, still);
  // The window is narrower than one copy of the list, so at most one copy is drawn. It is one
  // element whose `order` moves: the jump back to the middle copy never remounts it.
  const shown = slots.find(drawn);
  return (
    <>
      {slots
        .filter((slot) => slot !== shown)
        .map((slot) => (
          <div key={slot} aria-hidden style={{ width: PANEL, order: slot }} className="shrink-0" />
        ))}
      {shown === undefined ? null : <SessionPanel key="panel" order={shown} run={play.run} play={play} instant={instant} onHold={hold} />}
    </>
  );
}

/**
 * The mark of what started a run: the integration's logo as a flat glyph in
 * the theme ink (the site's logo set), a clock for a schedule, a terminal for
 * the setup prompt, a bolt for any other event.
 */
function TriggerMark({ via, terminal }: { via?: string; terminal: boolean }) {
  const glyph = 'text-muted-foreground size-4 shrink-0';
  if (terminal) return <TerminalWindowIcon aria-hidden className={glyph} />;
  if (via === 'schedule') return <ClockIcon aria-hidden className={glyph} />;
  if (!via) return <LightningIcon aria-hidden className={glyph} />;
  // The brand's own colors where a color file exists; a one-color mark (GitHub) stays white.
  if (FULL_COLOR_LOGOS.has(via)) {
    // eslint-disable-next-line @next/next/no-img-element -- a 16px static SVG; next/image adds nothing here
    return <img src={`/media/landing/logos/color/${via}.svg`} alt="" width={16} height={16} className="size-4 shrink-0" />;
  }
  return (
    <span
      aria-hidden
      className="bg-foreground size-4 shrink-0"
      style={{ maskImage: `url(/media/landing/logos/${via}.svg)`, maskSize: 'contain', maskRepeat: 'no-repeat', maskPosition: 'center' }}
    />
  );
}

/** One session window: what started it, the agent and the conversation. */
function SessionPanel({
  order,
  run,
  play,
  instant,
  onHold,
}: {
  /** The panel's slot in the tripled list. */
  order: number;
  run: HeroRun;
  /** Where this run's session stands; the reel keeps it, so every copy of the run shows the same. */
  play: Play;
  instant: boolean;
  onHold: (held: boolean) => void;
}) {
  const { beat, round, working } = play;
  const shownBeat = beat;
  return (
    <article
      style={{ width: PANEL, order }}
      onMouseEnter={() => onHold(true)}
      onMouseLeave={() => onHold(false)}
      onFocus={() => onHold(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) onHold(false);
      }}
      className={cn(
        'bg-card border-border flex h-108 shrink-0 flex-col overflow-hidden rounded-xl border',
      )}
    >
      {/* What started the run, first: most runs are started by an integration, not by a person typing. */}
      <div className="border-border flex h-11 shrink-0 items-center gap-2.5 border-b px-4">
        <TriggerMark via={run.via} terminal={run.host.kind === 'claude-code'} />
        <span className="text-foreground min-w-0 truncate text-sm font-medium">{run.source}</span>
        {/* Who picked it up, at the row's end. */}
        <span className="ml-auto flex shrink-0 items-center gap-2">
          {run.host.kind === 'claude-code' ? (
            <span className="border-border inline-flex size-5 shrink-0 items-center justify-center rounded-sm border">
              <Claude className="size-3" />
            </span>
          ) : (
            <AgentTile slug={run.host.slug} />
          )}
          <span className="text-muted-foreground text-sm">{run.host.kind === 'claude-code' ? 'Claude Code' : run.host.name}</span>
        </span>
      </div>

      {/* The conversation never scrolls under the reader's wheel or finger: a page scroll over the reel
          always moves the page. What does not fit is clipped. */}
      <div
        key={`${run.id}-${round}`}
        className={cn(
          'flex min-h-0 flex-1 flex-col gap-4 overflow-hidden px-4 pt-4 pb-8',
          round > 0 && 'animate-in fade-in duration-slow',
        )}
      >
        <div className="flex flex-col items-end gap-2">
          <p className="bg-muted text-foreground ml-8 rounded-lg px-3 py-2.5 text-sm">
            {/* The clamp sits on the text, not the padded bubble, so no half line shows below it. */}
            <span className="line-clamp-3 whitespace-pre-line">{run.ask}</span>
          </p>
          {run.context ? (
            <Beat instant={instant} at={1} beat={shownBeat}>
              <span className="text-muted-foreground text-xs">
                <span className="text-foreground">{run.context}</span> added to context
              </span>
            </Beat>
          ) : null}
        </div>

        <Beat instant={instant} at={2} beat={shownBeat} className="flex flex-col gap-3">
          <WorkFold run={run} working={working} />
          <Beat instant={instant} at={3} beat={shownBeat}>
            <p className="text-foreground text-sm text-pretty">{run.answer}</p>
          </Beat>
        </Beat>

        {run.rows ? (
          <Beat instant={instant} at={4} beat={shownBeat}>
            <ul className="border-border divide-border divide-y rounded-lg border">
              {run.rows.map((row) => (
                <li key={row.label + row.text} className="flex items-baseline gap-3 px-3 py-2 text-xs">
                  <span className={cn('shrink-0 font-mono', row.done ? 'text-foreground' : 'text-muted-foreground')}>{row.label}</span>
                  <span className="text-muted-foreground truncate">{row.text}</span>
                </li>
              ))}
            </ul>
          </Beat>
        ) : null}

        {run.result ? (
          <Beat instant={instant} at={4} beat={shownBeat}>
            <div className="border-border flex flex-col gap-1 rounded-lg border px-3 py-2.5">
              <span className="text-muted-foreground font-mono text-xs">{run.result.kind}</span>
              <span className="text-foreground line-clamp-2 text-sm font-medium">{run.result.title}</span>
              <span className="text-muted-foreground inline-flex items-center gap-1.5 text-xs">
                <span aria-hidden className="bg-kortix-base size-1.5 rounded-full" />
                {run.result.status}
              </span>
            </div>
          </Beat>
        ) : null}

      </div>

    </article>
  );
}

