'use client';

import { REFERENCE_REPOS, loopPrompt, setupPromptFor } from '@kortix/shared/setup-guide';
import { useEffect, useRef, type ReactNode } from 'react';

import { FactoryClip } from './factory-clip';
import type { LoopView } from './loops-content';
import { CopyButton, Eyebrow, useSetupTarget } from './parts';
import { SCENES } from './scenes';

/** The workspace every card sits in: one Kortix workspace is the company. Synthetic name. */
const WORKSPACE = 'your-company';
/** Where a stuck card's top sits below the 64 px header, and how far each next card steps down. */
const STICK_TOP = 88;
const STEP = 14;
/** How far a card shrinks and dims for each card stacked on it. */
const SHRINK = 0.04;
const DIM = 0.18;

/**
 * Stacked cards, one per factory. Each card sticks below the header; the next
 * one slides over it and the cards beneath shrink and dim, so the stack reads
 * as a deck. Below `lg` the cards are a plain list.
 */
export function FactoryStack({ loops, more }: { loops: LoopView[]; more: string[] }) {
  const cards = useRef<Array<HTMLDivElement | null>>([]);

  useEffect(() => {
    const stack = window.matchMedia('(min-width: 1024px) and (prefers-reduced-motion: no-preference)');
    let frame = 0;
    const paint = () => {
      frame = 0;
      const els = cards.current.filter((el): el is HTMLDivElement => el !== null);
      els.forEach((el, i) => {
        const inner = el.firstElementChild as HTMLElement | null;
        if (!inner) return;
        if (!stack.matches) {
          inner.style.transform = '';
          inner.style.filter = '';
          return;
        }
        // Depth: how many later cards cover this one, each counted 0..1 as it slides in.
        const height = el.getBoundingClientRect().height || 1;
        let depth = 0;
        els.slice(i + 1).forEach((next, offset) => {
          const stuck = STICK_TOP + STEP * (i + 1 + offset);
          depth += Math.min(1, Math.max(0, 1 - (next.getBoundingClientRect().top - stuck) / height));
        });
        inner.style.transform = `scale(${1 - SHRINK * depth})`;
        inner.style.filter = depth > 0 ? `brightness(${1 - DIM * Math.min(depth, 2)})` : '';
      });
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(paint);
    };
    paint();
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    stack.addEventListener('change', schedule);
    return () => {
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      stack.removeEventListener('change', schedule);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);

  const total = loops.length + 1;
  const slot = (index: number, children: ReactNode, id: string) => (
    <div
      key={id}
      id={`factory-${id}`}
      ref={(el) => {
        cards.current[index] = el;
      }}
      className="scroll-mt-24 lg:sticky"
      style={{ top: STICK_TOP + STEP * index }}
    >
      <div className="border-border bg-card origin-top overflow-hidden rounded-xl border shadow-2xl shadow-black/50 will-change-transform">{children}</div>
    </div>
  );

  return (
    <div className="flex flex-col gap-6 px-4 pb-24 md:px-8 lg:gap-[16vh]">
      {loops.map((loop, index) => slot(index, <FactoryCard loop={loop} index={index} total={total} />, loop.id))}
      {slot(loops.length, <MoreCard more={more} index={loops.length} total={total} />, 'more')}
      {/* Sticky cards stop at their parent's content edge: this keeps the last card's stop in reach. */}
      <div aria-hidden className="hidden lg:block" />
    </div>
  );
}

function CardBar({ index, total, team }: { index: number; total: number; team: string }) {
  return (
    <div className="border-border text-muted-foreground flex items-center justify-between border-b px-6 py-3 font-mono text-xs">
      <span>
        {WORKSPACE} <span className="text-muted-foreground/50">/</span> <span className="text-foreground">{team.toLowerCase()}</span>
      </span>
      <span>
        {String(index + 1).padStart(2, '0')} / {String(total).padStart(2, '0')}
      </span>
    </div>
  );
}

const CARD_GRID = 'grid grid-cols-[minmax(0,1fr)] lg:h-[400px] lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]';

/** One factory: its name, one line and its prompt, beside a clip of what it does. */
function FactoryCard({ loop, index, total }: { loop: LoopView; index: number; total: number }) {
  const prompt = loopPrompt(loop, useSetupTarget());
  const reference = REFERENCE_REPOS[loop.id];
  const scene = SCENES[loop.id];
  return (
    <>
      <CardBar index={index} total={total} team={loop.team} />
      <div className={CARD_GRID}>
        <div className="border-border flex flex-col gap-8 border-b p-6 md:p-8 lg:border-r lg:border-b-0">
          <div className="flex flex-col gap-3">
            <h3 className="text-foreground text-3xl font-medium tracking-tight lg:text-[40px] lg:leading-tight">{loop.name}</h3>
            <p className="text-muted-foreground max-w-sm text-base text-pretty">{loop.line}</p>
          </div>
          <div className="mt-auto flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-4">
              <CopyButton text={prompt} label="Copy the prompt" />
              {reference ? (
                <a href={reference} className="text-muted-foreground hover:text-foreground text-sm underline-offset-4 hover:underline">
                  See the template
                </a>
              ) : null}
            </div>
            <span className="text-muted-foreground font-mono text-xs">
              1 agent · {loop.triggers} triggers · {loop.skills} {loop.skills === 1 ? 'skill' : 'skills'}
            </span>
          </div>
        </div>
        <div className="flex min-w-0 p-6 md:p-8">{scene ? <FactoryClip scene={scene} agent={loop.agent} /> : null}</div>
      </div>
    </>
  );
}

/** The last card: every other team, built from a description by the same prompt. */
function MoreCard({ more, index, total }: { more: string[]; index: number; total: number }) {
  const prompt = setupPromptFor(useSetupTarget());
  return (
    <>
      <CardBar index={index} total={total} team="& more" />
      <div className={CARD_GRID}>
        <div className="border-border flex flex-col gap-8 border-b p-6 md:p-8 lg:border-r lg:border-b-0">
          <div className="flex flex-col gap-3">
            <h3 className="text-foreground text-3xl font-medium tracking-tight lg:text-[40px] lg:leading-tight">Any loop you describe.</h3>
            <p className="text-muted-foreground max-w-sm text-base text-pretty">Say what should happen and when. Your agent writes it as code.</p>
          </div>
          <div className="mt-auto">
            <CopyButton text={prompt} />
          </div>
        </div>
        <div className="flex min-w-0 flex-col justify-center gap-4 p-6 md:p-8">
          <Eyebrow>For example</Eyebrow>
          <ul className="flex flex-wrap gap-2">
            {more.map((name) => (
              <li key={name} className="border-border text-foreground rounded-full border px-4 py-2 text-sm">
                {name}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </>
  );
}
