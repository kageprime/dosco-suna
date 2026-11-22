'use client';

/**
 * ActionBar — the one floating bar that sits at the bottom centre of a page
 * while a temporary mode is open: a multi-selection ("3 selected"), unsaved
 * edits ("Unsaved changes"), or a pending clipboard ("Moving 2 items").
 *
 * Anatomy, left to right:
 *   [leading] title  description          [ action ⌘K | action | action ]  [×]
 *
 * - `title` states the mode in a few words. `description` adds one muted fact
 *   (the changed tabs, a selection limit). Both truncate; nothing wraps.
 * - `actions` render as one `secondary` ButtonGroup of text buttons. An action
 *   may carry a `kbd` hint (one `Kbd` per key in a `KbdGroup`; `'mod'` draws ⌘
 *   on a Mac and Ctrl elsewhere), a `destructive` or `success` tone, a `primary`
 *   emphasis (the one commit verb, such as Save), and its own `loading` state.
 * - `close` adds the trailing × that leaves the mode. Its label is the
 *   tooltip and the accessible name ("Exit selection").
 * - `busy` puts the session dot matrix before the title and disables every
 *   control, for a running bulk action or save.
 *
 * Under 32rem of its own width (container query) the actions drop to a second
 * full-width row, so every label still reads.
 *
 * It enters with a short rise and fade (reduced motion keeps the fade) and
 * leaves at once. `animateIn={false}` skips the enter, for a bar opened from
 * the keyboard.
 *
 * Place it with `ActionBarDock`, which pins it to the bottom of the nearest
 * positioned ancestor (the list column), not to the end of the list.
 *
 * `kbd` only DRAWS the key. The page owns the shortcut binding, because the
 * page decides when the key is live (focus in an input, a dialog open).
 */

import { XIcon } from '@phosphor-icons/react';
import { m } from 'motion/react';
import { type ReactNode, useSyncExternalStore } from 'react';

import { useReducedMotion } from '../lib/reduced-motion';
import { cn } from '../lib/utils';
import { Button } from './button';
import { ButtonGroup } from './button-group';
import { SessionDotMatrix } from './dot-matrix/session-dot-matrix';
import Hint from './hint';
import { Kbd, KbdGroup } from './kbd';
import Loading from './loading';

export interface ActionBarAction {
  id: string;
  label: string;
  /** `success` for an approving verb (Approve), `destructive` for a removing one (Delete). */
  tone?: 'default' | 'success' | 'destructive';
  /** `primary` fills the button. Give it to at most one action: the commit verb. */
  emphasis?: 'default' | 'primary';
  /**
   * The shortcut drawn after the label, one entry per key: `['mod', 'S']`.
   * `'mod'` is ⌘ on a Mac and Ctrl elsewhere. Display only: the page binds it.
   */
  kbd?: readonly string[];
  disabled?: boolean;
  /** This action alone is running: a spinner leads its label and it disables. */
  loading?: boolean;
  onSelect: () => void;
}

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform);
const noopSubscribe = () => () => {};
// The server cannot know the platform: it renders ⌘, the client corrects after hydration.
function useIsMac() {
  return useSyncExternalStore(noopSubscribe, () => IS_MAC, () => true);
}

const MOD_SYMBOL = { mac: '⌘', other: 'Ctrl' } as const;
const SHIFT_ALT_SYMBOL: Record<string, string> = { shift: '⇧', alt: '⌥' };
const ARIA_NAME: Record<string, string> = { shift: 'Shift', alt: 'Alt' };

/** The drawn label of one key: `'mod'` → ⌘ / Ctrl, `'shift'` → ⇧, a letter in capitals. */
export function keyLabel(key: string, isMac: boolean): string {
  if (key === 'mod') return isMac ? MOD_SYMBOL.mac : MOD_SYMBOL.other;
  return SHIFT_ALT_SYMBOL[key] ?? (key.length === 1 ? key.toUpperCase() : key);
}

/** `aria-keyshortcuts` takes key names joined by `+`: `['mod', 'S']` → `Meta+S` / `Control+S`. */
export function toAriaKeyshortcuts(keys: readonly string[], isMac: boolean): string {
  return keys
    .map((k) =>
      k === 'mod' ? (isMac ? 'Meta' : 'Control') : (ARIA_NAME[k] ?? (k.length === 1 ? k.toUpperCase() : k)),
    )
    .join('+');
}

const EASE_OUT = [0.23, 1, 0.32, 1] as const;
// A full transform string, not `y`: it runs on the compositor while the list loads.
const RISE = 'translateY(8px)';
const REST = 'translateY(0px)';

export function ActionBar({
  title,
  description,
  leading,
  actions,
  close,
  busy = false,
  animateIn = true,
  className,
}: {
  /** The mode in a few words: "3 selected", "Unsaved changes". Read by screen readers on change. */
  title: ReactNode;
  /** One muted fact after the title. */
  description?: ReactNode;
  /** A glyph before the title, such as the clipboard icon. Replaced by the dot matrix while `busy`. */
  leading?: ReactNode;
  actions: readonly ActionBarAction[];
  /** Adds the trailing × that leaves the mode. */
  close?: { label: string; onSelect: () => void };
  /** A bulk action or save is running: the dot matrix leads and every control disables. */
  busy?: boolean;
  /** False skips the enter animation (the mode opened from the keyboard). */
  animateIn?: boolean;
  className?: string;
}) {
  const reduceMotion = useReducedMotion();
  const isMac = useIsMac();
  return (
    <m.div
      data-slot="action-bar"
      initial={animateIn ? { opacity: 0, transform: reduceMotion ? REST : RISE } : false}
      animate={{
        opacity: 1,
        transform: REST,
        transition: { duration: 0.18, ease: EASE_OUT },
      }}
      className={cn(
        'bg-popover text-popover-foreground border-border @container/action-bar w-full rounded-lg border p-2 pl-3.5 shadow-md',
        className,
      )}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span
          className="order-1 flex min-w-0 flex-1 items-center gap-2 text-sm font-medium tabular-nums"
          aria-live="polite"
        >
          {busy ? (
            <SessionDotMatrix size={14} className="shrink-0" />
          ) : leading ? (
            <span className="text-muted-foreground flex shrink-0 [&_svg]:size-4">{leading}</span>
          ) : null}
          <span className="min-w-0 truncate">{title}</span>
          {description ? (
            <span className="text-muted-foreground min-w-0 shrink-[2] truncate font-normal">{description}</span>
          ) : null}
        </span>
        {actions.length > 0 ? (
          <ButtonGroup className="order-3 w-full @lg/action-bar:order-2 @lg/action-bar:w-auto @lg/action-bar:shrink-0">
            {actions.map((a) => (
              <Button
                key={a.id}
                type="button"
                variant={a.emphasis === 'primary' ? 'default' : 'secondary'}
                size="sm"
                onClick={a.onSelect}
                disabled={busy || a.disabled || a.loading}
                aria-busy={a.loading || undefined}
                aria-keyshortcuts={a.kbd?.length ? toAriaKeyshortcuts(a.kbd, isMac) : undefined}
                className={cn(
                  'h-8 min-w-0 flex-auto gap-1.5 px-1.5 @lg/action-bar:flex-none @lg/action-bar:px-3',
                  a.tone === 'destructive' && 'text-destructive hover:text-destructive',
                  a.tone === 'success' && 'text-kortix-green hover:text-kortix-green',
                )}
              >
                {a.loading ? <Loading className="size-3.5 shrink-0" /> : null}
                <span className="truncate">{a.label}</span>
                {a.kbd?.length ? (
                  <KbdGroup>
                    {a.kbd.map((key) => (
                      <Kbd
                        key={key}
                        className={cn(
                          'font-mono',
                          a.emphasis === 'primary' && 'text-action-foreground/70',
                        )}
                      >
                        {keyLabel(key, isMac)}
                      </Kbd>
                    ))}
                  </KbdGroup>
                ) : null}
              </Button>
            ))}
          </ButtonGroup>
        ) : null}
        {close ? (
          <Hint label={close.label} side="top">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={close.label}
              onClick={close.onSelect}
              disabled={busy}
              className="order-2 size-8 shrink-0 @lg/action-bar:order-3"
            >
              <XIcon className="size-4 shrink-0" />
            </Button>
          </Hint>
        ) : null}
      </div>
    </m.div>
  );
}

/**
 * Pins an `ActionBar` to the bottom centre of the nearest positioned ancestor,
 * 16px off its bottom edge, at most 36rem wide. Clicks pass through the empty
 * strip around the bar.
 */
export function ActionBarDock({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      data-slot="action-bar-dock"
      className={cn(
        'pointer-events-none absolute inset-x-0 bottom-4 z-30 flex justify-center px-4',
        className,
      )}
    >
      <div className="pointer-events-auto w-full max-w-xl">{children}</div>
    </div>
  );
}
