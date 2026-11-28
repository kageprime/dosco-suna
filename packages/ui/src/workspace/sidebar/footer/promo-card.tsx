'use client';

import { ArrowRightIcon, XIcon } from '@phosphor-icons/react';
import { useId, useState, useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import Loading from '../../../primitives/loading';
import { BeamsStill } from '../../../primitives/paper-wallpaper-shaders';
import { cn } from '../../../internal/lib/utils';

/** One promo the switcher can show. */
export interface PromoSlide {
  /** Stable key, also the dot's identity. */
  id: string;
  /** The art row: a few `PromoMark` tiles. */
  marks: ReactNode;
  title: string;
  description: string;
  cta: string;
  dismissLabel: string;
  onDismiss: () => void;
  onClick: () => void;
  pending?: boolean;
}

/**
 * The sidebar's advertisements, one card at a time. Every slide is a card: an
 * art header with a row of marks, a title, one sentence and a call to action.
 * The header is the still of the art in the dialog the card opens, dimmed,
 * with the marks floating on it, so the click lands where the card promised.
 *
 * All slides share one grid cell, so the card is as tall as its tallest slide
 * and switching never moves the session list above. The dots switch by hand;
 * nothing rotates on its own, because the sidebar is always on screen. A
 * dismissed slide leaves, and the next one takes its place.
 *
 * In flow, so a border and no shadow (effects.md); hover is color only. On a
 * window under 52rem tall the sentence folds away.
 */
export function PromoSwitcher({
  slides,
  label,
  variant = 'inline',
  composer,
}: {
  slides: readonly PromoSlide[];
  label: string;
  /** `floating`: a card pinned to the window's bottom-right corner, over the page. */
  variant?: 'inline' | 'floating';
  /**
   * Floating only: the page's bottom composer. `centered` (home, a session):
   * the card clears it only from a 1700px window, so below that it hides.
   * `full` (chat, DMs, channels, Spaces): the composer runs to the window's
   * right edge, so the card never shows.
   */
  composer?: 'centered' | 'full';
}) {
  const id = useId();
  const [activeId, setActiveId] = useState<string | null>(null);
  if (slides.length === 0) return null;
  // The chosen slide, or the first one when it was dismissed or none was chosen.
  const active = slides.find((slide) => slide.id === activeId) ?? slides[0];
  if (variant === 'floating') {
    return (
      <FloatingPromo
        id={id}
        slides={slides}
        active={active}
        label={label}
        composer={composer}
        onSelect={setActiveId}
      />
    );
  }

  return (
    <li
      className="group/promo relative list-none"
      role="region"
      aria-roledescription="carousel"
      aria-label={label}
    >
      <div className="grid">
        {slides.map((slide) => {
          const current = slide.id === active.id;
          return (
            <button
              key={slide.id}
              type="button"
              disabled={slide.pending}
              aria-busy={slide.pending || undefined}
              aria-labelledby={`${id}-${slide.id}-title`}
              aria-describedby={`${id}-${slide.id}-description`}
              inert={!current}
              onClick={slide.onClick}
              className={cn(
                'bg-background border-border hover:bg-hover focus-visible:ring-ring col-start-1 row-start-1 flex w-full cursor-pointer flex-col overflow-hidden rounded-md border text-left transition-[background-color,opacity] duration-moderate outline-none focus-visible:ring-2 disabled:pointer-events-none disabled:opacity-60 motion-reduce:transition-none',
                !current && 'pointer-events-none opacity-0',
              )}
            >
              {/* Dark in both themes, like every art pane. */}
              <span
                aria-hidden="true"
                className="dark bg-background relative isolate flex h-16 w-full shrink-0 items-center justify-center gap-4 border-b"
              >
                <BeamsStill />
                {/* Dims the beams to near-black, so the marks float on a calm ground. */}
                <span className="bg-background/50 absolute inset-0" />
                {slide.marks}
              </span>
              <span className="flex flex-1 flex-col gap-2 p-3">
                <span className="space-y-1">
                  <span
                    id={`${id}-${slide.id}-title`}
                    className="text-foreground block text-sm leading-snug font-medium text-balance"
                  >
                    {slide.title}
                  </span>
                  <span
                    id={`${id}-${slide.id}-description`}
                    className="text-muted-foreground block text-xs leading-relaxed text-pretty [@media(max-height:52rem)]:hidden"
                  >
                    {slide.description}
                  </span>
                </span>
                {/* Pinned to the foot, level with the dots, whatever the slide's length. */}
                <span className="text-foreground mt-auto inline-flex items-center gap-1 text-xs font-medium">
                  {slide.pending ? <Loading className="size-3.5 shrink-0" /> : null}
                  {slide.cta}
                  {slide.pending ? null : <ArrowRightIcon className="size-3 shrink-0" />}
                </span>
              </span>
            </button>
          );
        })}
      </div>
      {/* On the art, so it takes the art's dark scope. It dismisses the slide
          on show. */}
      <button
        type="button"
        onClick={active.onDismiss}
        aria-label={active.dismissLabel}
        className="text-muted-foreground hover:bg-active hover:text-foreground focus-visible:ring-ring dark absolute top-1.5 right-1.5 flex size-6 items-center justify-center rounded-sm opacity-0 transition-[color,background-color,opacity] duration-fast outline-none group-focus-within/promo:opacity-100 group-hover/promo:opacity-100 focus-visible:ring-2 max-md:opacity-100"
      >
        <XIcon className="size-3.5" />
      </button>
      {slides.length > 1 ? (
        <div className="absolute right-2 bottom-2 flex items-center">
          {slides.map((slide) => {
            const current = slide.id === active.id;
            return (
              <button
                key={slide.id}
                type="button"
                aria-label={slide.title}
                aria-current={current || undefined}
                onClick={() => setActiveId(slide.id)}
                className="group/dot focus-visible:ring-ring flex size-6 cursor-pointer max-md:size-8 items-center justify-center rounded-sm outline-none focus-visible:ring-2"
              >
                <span
                  className={cn(
                    // Color only: the crossfade above is the one thing that moves.
                    'h-1.5 rounded-full transition-colors duration-fast',
                    current
                      ? 'bg-foreground w-4'
                      : 'bg-muted-foreground/40 group-hover/dot:bg-muted-foreground w-1.5',
                  )}
                />
              </button>
            );
          })}
        </div>
      ) : null}
    </li>
  );
}

/**
 * The promo card floating in the window's bottom-right corner, over the page:
 * a lifted card (`bg-popover`, `smooth-shadow-ring`, the shadow and its
 * hairline in one) with the art inset in a rounded panel, the close button on
 * the art, then the title, one sentence, the call to action and the dots.
 * Floating, so shadow + hairline (effects.md). Portaled to `document.body` so
 * no sidebar transform or overflow clips it.
 */
const subscribeNoop = () => () => {};

function FloatingPromo({
  id,
  slides,
  active,
  label,
  composer,
  onSelect,
}: {
  id: string;
  slides: readonly PromoSlide[];
  active: PromoSlide;
  label: string;
  composer?: 'centered' | 'full';
  onSelect: (slideId: string) => void;
}) {
  // `false` on the server and while hydrating, `true` after: the portal mounts
  // only once the page is hydrated, so both passes render the same nothing.
  const hydrated = useSyncExternalStore(
    subscribeNoop,
    () => true,
    () => false,
  );
  if (!hydrated || composer === 'full') return null;
  return createPortal(
    <div
      role="region"
      aria-roledescription="carousel"
      aria-label={label}
      className={cn(
        'bg-popover text-popover-foreground smooth-shadow-ring fixed right-4 bottom-4 z-40 w-80 rounded-xl p-1.5',
        composer === 'centered' && 'hidden min-[1700px]:block',
      )}
    >
      <div className="grid">
        {slides.map((slide) => {
          const current = slide.id === active.id;
          return (
            <button
              key={slide.id}
              type="button"
              disabled={slide.pending}
              aria-busy={slide.pending || undefined}
              aria-labelledby={`${id}-${slide.id}-title`}
              aria-describedby={`${id}-${slide.id}-description`}
              inert={!current}
              onClick={slide.onClick}
              className={cn(
                'focus-visible:ring-ring col-start-1 row-start-1 flex w-full cursor-pointer flex-col rounded-lg text-left transition-opacity duration-moderate outline-none focus-visible:ring-2 disabled:pointer-events-none disabled:opacity-60 motion-reduce:transition-none',
                !current && 'pointer-events-none opacity-0',
              )}
            >
              {/* Dark in both themes, like every art pane. */}
              <span
                aria-hidden="true"
                className="dark bg-background relative isolate flex h-28 w-full shrink-0 items-center justify-center gap-5 overflow-hidden rounded-lg"
              >
                <BeamsStill />
                <span className="bg-background/50 absolute inset-0" />
                {slide.marks}
              </span>
              <span className="flex flex-col px-2 pt-3">
                <span className="space-y-1">
                  <span
                    id={`${id}-${slide.id}-title`}
                    className="text-foreground block text-sm leading-snug font-medium text-balance"
                  >
                    {slide.title}
                  </span>
                  <span
                    id={`${id}-${slide.id}-description`}
                    className="text-muted-foreground block text-sm leading-relaxed text-pretty"
                  >
                    {slide.description}
                  </span>
                </span>
              </span>
            </button>
          );
        })}
      </div>
      {/* On the art, so it takes the art's dark scope. */}
      <button
        type="button"
        onClick={active.onDismiss}
        aria-label={active.dismissLabel}
        className="text-foreground hover:bg-active focus-visible:ring-ring dark absolute top-3 right-3 flex size-7 items-center justify-center rounded-md transition-colors duration-fast outline-none focus-visible:ring-2"
      >
        <XIcon className="size-4" />
      </button>
      {/* In flow: the action and the dots share one row and wrap rather than
          overlap when a translated label runs long. */}
      <div className="flex flex-wrap items-center justify-between gap-2 px-2 pt-3 pb-1.5">
        <button
          type="button"
          disabled={active.pending}
          onClick={active.onClick}
          className="bg-secondary text-secondary-foreground hover:bg-active focus-visible:ring-ring inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-sm font-medium transition-colors duration-fast outline-none focus-visible:ring-2 disabled:pointer-events-none disabled:opacity-60"
        >
          {active.pending ? <Loading className="size-3.5 shrink-0" /> : null}
          {active.cta}
          {active.pending ? null : <ArrowRightIcon className="size-3.5 shrink-0" />}
        </button>
        {slides.length > 1 ? (
          <div className="flex items-center">
            {slides.map((slide) => {
              const current = slide.id === active.id;
              return (
                <button
                  key={slide.id}
                  type="button"
                  aria-label={slide.title}
                  aria-current={current || undefined}
                  onClick={() => onSelect(slide.id)}
                  className="group/dot focus-visible:ring-ring flex size-6 cursor-pointer items-center justify-center rounded-sm outline-none focus-visible:ring-2"
                >
                  <span
                    className={cn(
                      'h-1.5 rounded-full transition-colors duration-fast',
                      current
                        ? 'bg-foreground w-4'
                        : 'bg-muted-foreground/40 group-hover/dot:bg-muted-foreground w-1.5',
                    )}
                  />
                </button>
              );
            })}
          </div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}

/**
 * One mark on a card's art, with no tile: white under the art's `dark` scope
 * (`text-foreground`) unless it carries its own brand colors.
 */
export function PromoMark({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <span title={label} className="text-foreground relative flex shrink-0 items-center justify-center">
      {children}
    </span>
  );
}
