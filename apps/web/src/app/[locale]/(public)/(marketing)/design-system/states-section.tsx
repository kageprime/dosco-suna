'use client';

/**
 * Body of the States section: the four states of a list and the four states
 * of an action, side by side, each with the one primitive that draws it.
 * The rules are `kortix-brand` layout.md "States" and `kortix-design-system`
 * "Which component for which state". The demo copy is English: it shows the
 * shape of the copy (one title, one sentence), not product text.
 */

import { Button } from '@kortix/ui/button';
import { EmptyArt } from '@kortix/ui/empty-art';
import { EmptyState } from '@kortix/ui/empty-state';
import { ErrorState } from '@kortix/ui/error-state';
import { SolidCheckIcon } from '@kortix/ui/internal/icons/solid-check-icon';
import Loading from '@kortix/ui/loading';
import { Skeleton } from '@kortix/ui/skeleton';
import { successToast } from '@kortix/ui/toast';
import { ArrowsClockwiseIcon, ChatCircleIcon, PlusIcon } from '@phosphor-icons/react';
import { useEffect, useRef, useState } from 'react';

import { Spec, SpecCell, SpecGrid } from './spec';

const ROWS = ['Draft the weekly digest', 'Sync the repo', 'Run the invoices'] as const;

function ListRows() {
  return (
    <ul className="w-full max-w-64 space-y-2">
      {ROWS.map((name) => (
        <li
          key={name}
          className="bg-popover border-border flex items-center gap-3 rounded-md border px-3 py-2"
        >
          <span className="flex size-5 shrink-0 items-center justify-center">
            <SolidCheckIcon className="text-kortix-green size-3.5" />
          </span>
          <span className="text-foreground min-w-0 flex-1 truncate text-sm">{name}</span>
        </li>
      ))}
    </ul>
  );
}

function SkeletonRows() {
  return (
    <div
      className="w-full max-w-64 space-y-2"
      role="status"
      aria-busy
      aria-label="Loading sessions"
    >
      {ROWS.map((name) => (
        <Skeleton key={name} className="h-11 py-0" />
      ))}
    </div>
  );
}

type Phase = 'idle' | 'pending' | 'done';

/** Idle → pending → done → idle. The label never moves; only the glyph swaps. */
function ActionDemo() {
  const [phase, setPhase] = useState<Phase>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const run = () => {
    if (phase !== 'idle') return;
    setPhase('pending');
    timer.current = setTimeout(() => {
      setPhase('done');
      successToast('Saved');
      timer.current = setTimeout(() => setPhase('idle'), 1400);
    }, 900);
  };

  return (
    <Button
      size="sm"
      variant="secondary"
      onClick={run}
      disabled={phase === 'pending'}
      aria-busy={phase === 'pending'}
    >
      {phase === 'pending' ? (
        <Loading className="size-3.5 shrink-0" />
      ) : phase === 'done' ? (
        <SolidCheckIcon className="text-kortix-green size-3.5 shrink-0" />
      ) : (
        <PlusIcon className="size-3.5 shrink-0" />
      )}
      Save
    </Button>
  );
}

export function StatesSection() {
  return (
    <>
      <Spec
        id="states-list"
        name="A list"
        about={
          <>
            One primitive per state: <code>Skeleton</code> rows, <code>EmptyState</code> with{' '}
            <code>EmptyArt</code>, <code>ErrorState</code> with Try again, then the rows. Never a
            spinner for a list.
          </>
        }
        source="skeleton.tsx · empty-state.tsx · error-state.tsx"
      >
        <SpecGrid>
          <SpecCell label="Loading" about="Skeleton rows, the row's height, no stagger.">
            <SkeletonRows />
          </SpecCell>
          <SpecCell
            label="Empty"
            about="One title, one sentence, one action. The glyph is the tab's noun."
          >
            <EmptyState
              size="sm"
              media={<EmptyArt icon={ChatCircleIcon} />}
              title="No sessions yet"
              description="Sessions you start will show up here."
              action={
                <Button variant="outline" size="sm" className="gap-1.5">
                  <PlusIcon className="size-3.5 shrink-0" />
                  New session
                </Button>
              }
            />
          </SpecCell>
          <SpecCell
            label="Error"
            about="Could not {verb} {object}, then Try again. No wrapper box of its own."
          >
            <ErrorState
              size="sm"
              title="Could not load sessions"
              description="The request timed out."
              action={
                <Button variant="outline" size="sm" className="gap-1.5">
                  <ArrowsClockwiseIcon className="size-3.5 shrink-0" />
                  Try again
                </Button>
              }
            />
          </SpecCell>
          <SpecCell
            label="Loaded"
            about="The rows. A completion uses SolidCheckIcon without a checkbox tile. The label stays ink."
          >
            <ListRows />
          </SpecCell>
        </SpecGrid>
      </Spec>

      <Spec
        id="states-action"
        name="An action"
        about={
          <>
            The label never changes: pending disables the control and swaps the glyph for{' '}
            <code>Loading</code>; done swaps it for a check with one <code>successToast</code>.
            Nothing moves and no second line appears.
          </>
        }
        source="loading.tsx · toast.tsx"
      >
        <SpecGrid className="sm:grid-cols-4">
          <SpecCell label="Idle" contentClassName="min-h-24">
            <Button size="sm" variant="secondary">
              <PlusIcon className="size-3.5 shrink-0" />
              Save
            </Button>
          </SpecCell>
          <SpecCell label="Pending" contentClassName="min-h-24">
            <Button size="sm" variant="secondary" disabled aria-busy>
              <Loading className="size-3.5 shrink-0" />
              Save
            </Button>
          </SpecCell>
          <SpecCell label="Done" contentClassName="min-h-24">
            <Button size="sm" variant="secondary">
              <SolidCheckIcon className="text-kortix-green size-3.5 shrink-0" />
              Save
            </Button>
          </SpecCell>
          <SpecCell label="Disabled" contentClassName="min-h-24">
            <Button size="sm" variant="secondary" disabled>
              <PlusIcon className="size-3.5 shrink-0" />
              Save
            </Button>
          </SpecCell>
        </SpecGrid>
        <SpecCell
          label="Live"
          about="Click it. Idle, pending, done, idle. The width does not change."
        >
          <ActionDemo />
        </SpecCell>
      </Spec>
    </>
  );
}
