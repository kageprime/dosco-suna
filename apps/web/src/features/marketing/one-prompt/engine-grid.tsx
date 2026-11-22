'use client';

import { YamlLine } from '@/features/marketing/code-panel';
import { cn } from '@kortix/ui';
import { useEffect, useState, useSyncExternalStore } from 'react';

import { ENGINE, MANIFEST } from './factory-content';

/**
 * For each line of the sample, the YAML keys it belongs to: its top-level
 * block (`agents`, `triggers`…), and, inside an agent, the field it sets
 * (`skills: [...]`, `secrets: [...]`). Hovering a part lights these lines.
 */
const LINE_KEYS: string[][] = (() => {
  let block = '';
  return MANIFEST.map((line) => {
    if (line === '') return [];
    const top = /^([a-z_]+):/.exec(line);
    if (top) {
      block = top[1]!;
      return [block];
    }
    const field = block === 'agents' ? /^ {4}([a-z_]+):/.exec(line) : null;
    return field ? [block, field[1]!] : [block];
  });
})();

/** The odd card spans both columns, so the grid fills the code's height with no empty corner. */
const WIDE = new Set([0, ENGINE.length - 1]);

/** How long the file stays on one part before it moves to the next. */
const TOUR_MS = 2600;

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';
function subscribeReducedMotion(onChange: () => void) {
  const query = window.matchMedia(REDUCED_MOTION);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

/**
 * kortix.yaml beside what it defines. On its own, the file walks through its
 * parts: one part's lines light up and its card lights with them, then the
 * next. Hover or focus a part to hold it. Reduced motion skips the walk.
 */
export function EngineGrid() {
  const [held, setFocus] = useState<string | null>(null);
  const [tour, setTour] = useState(0);
  const still = useSyncExternalStore(subscribeReducedMotion, () => window.matchMedia(REDUCED_MOTION).matches, () => false);
  useEffect(() => {
    if (still || held) return;
    const id = setInterval(() => setTour((value) => value + 1), TOUR_MS);
    return () => clearInterval(id);
  }, [still, held]);
  const focus = held ?? (still ? null : ENGINE[tour % ENGINE.length]!.key);
  return (
    <div className="border-border mt-16 grid grid-cols-[minmax(0,1fr)] overflow-hidden rounded-xl border lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
      <div className="border-border bg-card/40 border-b lg:border-r lg:border-b-0">
        <div className="border-border text-muted-foreground border-b px-6 py-3 font-mono text-xs">kortix.yaml</div>
        <pre className="overflow-x-auto px-6 py-5 font-mono text-xs leading-6">
          {MANIFEST.map((line, i) => (
            <span
              key={i}
              className={cn(
                // The line bleeds to the panel's edges, so its highlight is a full-width band.
                '-mx-6 block px-6 whitespace-pre transition-[opacity,background-color] duration-normal ease-out',
                focus && (LINE_KEYS[i]!.includes(focus) ? 'bg-kortix-base/15' : 'opacity-30'),
              )}
            >
              {line === '' ? ' ' : <YamlLine line={line} />}
            </span>
          ))}
        </pre>
      </div>
      <dl className="grid auto-rows-fr grid-cols-[minmax(0,1fr)] sm:grid-cols-2">
        {ENGINE.map((part, index) => (
          <div
            key={part.term}
            tabIndex={0}
            onMouseEnter={() => setFocus(part.key)}
            onMouseLeave={() => setFocus(null)}
            onFocus={() => setFocus(part.key)}
            onBlur={() => setFocus(null)}
            className={cn(
              'border-border flex flex-col justify-center gap-2 p-6 transition-colors outline-none duration-normal',
              focus === part.key ? 'bg-card' : focus && 'opacity-60',
              index < ENGINE.length - 1 && 'border-b',
              WIDE.has(index) ? 'sm:col-span-2' : index % 2 === 1 && 'sm:border-r',
            )}
          >
            <dt className="text-foreground text-sm font-medium">{part.term}</dt>
            <dd className="text-muted-foreground text-sm text-pretty">{part.body}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
