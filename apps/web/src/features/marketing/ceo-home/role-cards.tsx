'use client';

import { cn } from '@kortix/ui';
import { Button } from '@kortix/ui/button';
import Link from 'next/link';
import { useEffect, useRef, type ReactNode } from 'react';

import { FactoryClip } from '@/features/marketing/one-prompt/factory-clip';
import type { LoopView } from '@/features/marketing/one-prompt/loops-content';
import { Eyebrow } from '@/features/marketing/one-prompt/parts';
import { SCENES } from '@/features/marketing/one-prompt/scenes';

const WORKSPACE = 'your-company';
const STICK_TOP = 88;
const STEP = 14;
const SHRINK = 0.04;
const DIM = 0.18;

/**
 * The roles are a deck of cards, not a list. Each card sticks below the header;
 * the next one slides over it while the cards beneath shrink and dim. A live
 * clip on every card shows the signal, the agent's steps and the work waiting
 * for approval. Below `lg` the deck becomes a plain list.
 */
export function RoleCards({ roles, more }: { roles: LoopView[]; more: string[] }) {
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

  const total = roles.length + 1;
  const slot = (index: number, id: string, children: ReactNode) => (
    <div
      key={id}
      id={`role-${id}`}
      ref={(el) => {
        cards.current[index] = el;
      }}
      className="scroll-mt-24 lg:sticky"
      style={{ top: STICK_TOP + STEP * index }}
    >
      <div className="border-border bg-card origin-top overflow-hidden rounded-xl border shadow-2xl will-change-transform">{children}</div>
    </div>
  );

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-6 pb-24 lg:gap-32">
      {roles.map((role, index) => slot(index, role.id, <RoleCard role={role} index={index} total={total} />))}
      {slot(roles.length, 'more', <AnyRoleCard more={more} index={roles.length} total={total} />)}
      <div aria-hidden className="hidden lg:block" />
    </div>
  );
}

function CardBar({ team, index, total }: { team: string; index: number; total: number }) {
  return (
    <div className="border-border text-muted-foreground flex items-center justify-between border-b px-6 py-3 font-mono text-xs">
      <span>
        {WORKSPACE} <span className="text-muted-foreground">/</span> <span className="text-foreground">{team.toLowerCase()}</span>
      </span>
      <span>
        {String(index + 1).padStart(2, '0')} / {String(total).padStart(2, '0')}
      </span>
    </div>
  );
}

const GRID = 'grid grid-cols-[minmax(0,1fr)] lg:h-[400px] lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]';

function RoleCard({ role, index, total }: { role: LoopView; index: number; total: number }) {
  const scene = SCENES[role.id];
  return (
    <>
      <CardBar team={role.team} index={index} total={total} />
      <div className={GRID}>
        <div className="border-border flex flex-col gap-8 border-b p-6 md:p-8 lg:border-r lg:border-b-0">
          <div className="flex flex-col gap-3">
            <Eyebrow>{role.name}</Eyebrow>
            <h3 className="text-foreground text-3xl font-medium tracking-tight lg:text-[40px] lg:leading-tight">{role.team}</h3>
            <p className="text-muted-foreground max-w-sm text-base text-pretty">{role.line}</p>
          </div>
          <div className="mt-auto flex flex-col gap-4">
            <div>
              <Button asChild variant="brand" size="default" className="w-fit">
                <Link href="/auth">Start with this role</Link>
              </Button>
            </div>
            <span className="text-muted-foreground font-mono text-xs">
              1 agent · {role.triggersOn} {role.triggersOn === 1 ? 'trigger' : 'triggers'} · {role.skills} {role.skills === 1 ? 'skill' : 'skills'}
            </span>
          </div>
        </div>
        <div className="flex min-w-0 p-6 md:p-8">
          {scene ? (
            <FactoryClip scene={scene} agent={role.agent} />
          ) : (
            <div className="border-border bg-background flex w-full items-center justify-center rounded-lg border p-8 text-center">
              <p className="text-muted-foreground text-sm">This role watches for its signal and returns work for your approval.</p>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function AnyRoleCard({ more, index, total }: { more: string[]; index: number; total: number }) {
  return (
    <>
      <CardBar team="any role" index={index} total={total} />
      <div className={GRID}>
        <div className="border-border flex flex-col gap-8 border-b p-6 md:p-8 lg:border-r lg:border-b-0">
          <div className="flex flex-col gap-3">
            <Eyebrow>Beyond the first team</Eyebrow>
            <h3 className="text-foreground text-3xl font-medium tracking-tight lg:text-[40px] lg:leading-tight">Any role you describe.</h3>
            <p className="text-muted-foreground max-w-sm text-base text-pretty">Say what should happen and when. The setup writes it as code in the same file.</p>
          </div>
          <div className="mt-auto">
            <Button asChild variant="brand" size="default" className="w-fit">
              <Link href="/auth">Describe your role</Link>
            </Button>
          </div>
        </div>
        <div className="flex min-w-0 flex-col justify-center gap-4 p-6 md:p-8">
          <Eyebrow>For example</Eyebrow>
          <ul className="flex flex-wrap gap-2">
            {more.map((name) => (
              <li key={name} className={cn('border-border text-foreground rounded-full border px-4 py-2 text-sm')}>
                {name}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </>
  );
}
