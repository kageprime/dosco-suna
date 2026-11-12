import { cn } from '@kortix/ui';
import type { ReactNode } from 'react';

/*
 * The status mark the /enterprise and /compliance rows carry.
 */

/**
 * A state mark. Hue only where it reports a state (color.md status table):
 * green for done, yellow for waiting, red for refused. The word carries the
 * meaning.
 */
export type Tone = 'ok' | 'wait' | 'no';

const TONE: Record<Tone, { dot: string; tint: string }> = {
  ok: { dot: 'bg-kortix-green', tint: 'bg-kortix-green/15' },
  wait: { dot: 'bg-kortix-yellow', tint: 'bg-kortix-yellow/15' },
  no: { dot: 'bg-kortix-red', tint: 'bg-kortix-red/15' },
};

export function Status({ tone = 'ok', children }: { tone?: Tone; children: ReactNode }) {
  const t = TONE[tone];
  return (
    <span
      className={cn(
        'text-foreground inline-flex shrink-0 items-center gap-1.5 rounded-sm px-2 py-0.5 text-sm font-medium',
        t.tint,
      )}
    >
      <span aria-hidden className={cn('size-1.5 rounded-full', t.dot)} />
      {children}
    </span>
  );
}
