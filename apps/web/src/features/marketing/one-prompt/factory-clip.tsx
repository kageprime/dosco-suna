'use client';

import { cn } from '@kortix/ui';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';

import type { Scene } from './scenes';

/** One pass of a clip: the signal, one step every STEP_MS, the result, a hold. */
const STEP_MS = 800;
const LEAD_MS = 700;
const HOLD_MS = 2600;
const TICK_MS = 100;

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';
const prefersReducedMotion = () => window.matchMedia(REDUCED_MOTION).matches;
function subscribeReducedMotion(onChange: () => void) {
  const query = window.matchMedia(REDUCED_MOTION);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

/**
 * A factory's clip, drawn live: the signal arrives, the agent's steps appear
 * one by one, the result lands and waits for a person. It loops while it is on
 * screen and rests when it is not. Reduced motion shows the finished frame.
 */
export function FactoryClip({ scene, agent }: { scene: Scene; agent: string }) {
  const root = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const still = useSyncExternalStore(subscribeReducedMotion, prefersReducedMotion, () => false);
  const total = LEAD_MS + scene.steps.length * STEP_MS + HOLD_MS;

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const observer = new IntersectionObserver(([entry]) => setVisible(entry?.isIntersecting ?? false), { threshold: 0.5 });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible || still) return;
    const started = performance.now();
    const id = setInterval(() => setElapsed((performance.now() - started) % total), TICK_MS);
    return () => clearInterval(id);
  }, [visible, still, total]);

  const shown = still ? scene.steps.length : Math.max(0, Math.min(scene.steps.length, Math.floor((elapsed - LEAD_MS) / STEP_MS) + 1));
  const landed = still || elapsed >= LEAD_MS + scene.steps.length * STEP_MS;
  const progress = still ? 1 : elapsed / total;

  return (
    <div ref={root} className="border-border bg-background relative flex w-full flex-col overflow-hidden rounded-lg border">
      <div className="border-border text-muted-foreground flex items-center justify-between border-b px-4 py-2.5 font-mono text-[11px]">
        <span>{scene.signal.source}</span>
        <span className={cn('rounded-full px-2 py-0.5', scene.kind === 'real' ? 'bg-kortix-base/15 text-kortix-base' : 'bg-accent')}>
          {scene.kind === 'real' ? 'real run' : 'example'}
        </span>
      </div>

      <div className="flex flex-1 flex-col gap-4 p-5">
        <div className="border-border bg-card rounded-md border px-4 py-3">
          <span className="text-foreground line-clamp-1 text-sm">{scene.signal.title}</span>
        </div>

        <ol className="border-border ml-4 flex flex-col gap-2 border-l py-1 pl-5 font-mono text-xs leading-5">
          <li className="text-muted-foreground">agent · {agent}</li>
          {scene.steps.map((step, i) => (
            <li key={step.text} className={cn('truncate transition-opacity duration-300', i < shown ? 'opacity-100' : 'opacity-0', step.done ? 'text-kortix-base' : 'text-foreground')}>
              {step.text}
            </li>
          ))}
        </ol>

        <div className={cn('border-kortix-base/40 bg-kortix-base/5 mt-auto flex flex-col gap-1.5 rounded-md border px-4 py-3 transition-all duration-500', landed ? 'translate-y-0 opacity-100' : 'translate-y-2 opacity-0')}>
          <span className="text-kortix-base font-mono text-[11px]">{scene.ship.kind}</span>
          <span className="text-foreground line-clamp-1 text-sm font-medium">{scene.ship.title}</span>
          <span className="text-muted-foreground text-xs">{scene.ship.status}</span>
        </div>
      </div>

      <span aria-hidden className="bg-border absolute inset-x-0 bottom-0 h-px">
        <span className="bg-kortix-base block h-full" style={{ width: `${progress * 100}%` }} />
      </span>
    </div>
  );
}
