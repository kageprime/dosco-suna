'use client';

// Vendored extend.ai viewers (e.g. pdf-viewer.tsx) are written against
// extend.ai's own `ScrollArea`, which wraps `@base-ui/react/scroll-area` and
// exposes a richer prop surface (`orientation`, `scrollFade`,
// `viewportClassName`, `viewportProps`, `viewportRef`) than the app-wide
// `@kortix/ui/scroll-area`. This shim implements just the props the vendored
// viewers use on the same Base UI primitive, so the vendor diff in
// pdf-viewer.tsx stays a single import swap.
import { ScrollArea as ScrollAreaPrimitive } from '@base-ui/react/scroll-area';
import * as React from 'react';

import { cn } from '../../../lib/utils';

type ScrollAreaCompatProps = Omit<
  React.ComponentProps<typeof ScrollAreaPrimitive.Root>,
  'children'
> & {
  children?: React.ReactNode;
  orientation?: 'vertical' | 'horizontal' | 'both';
  /** Cosmetic-only in this shim (no CSS mask fade); accepted for API parity. */
  scrollFade?: boolean;
  /**
   * Cosmetic-only in this shim: the overlay scrollbar doesn't reflow layout
   * the way a native scrollbar does, so there's no gutter to reserve.
   * Accepted for API parity with extend.ai's ScrollArea.
   */
  scrollbarGutter?: boolean;
  viewportClassName?: string;
  /**
   * `ref` is typed by hand here (a plain `(instance) => void` callback plus
   * `RefObject`) instead of via `React.ComponentProps<typeof
   * ScrollAreaPrimitive.Viewport>`: the library's ref type is baked into its own
   * compiled `.d.ts`, independently instantiated from whatever callers pass
   * (e.g. `@extend-ai/react-xlsx`'s `viewportProps.ref`), and `@types/react`
   * 19.2's ref-cleanup-return branding makes those two independently
   * instantiated `Ref<HTMLDivElement>` types structurally incompatible even
   * though they're identical in shape (TS reports "two different types with
   * this name exist, but they are unrelated"). A plain `=> void` callback
   * sidesteps the branded cleanup-return type entirely — TS's "a function
   * returning anything is assignable where `void` is expected" rule then
   * accepts any caller's ref callback. `ref` is destructured out below and
   * merged with `viewportRef` — see `mergeRefs` — so it never needs to
   * satisfy the library's own nominal type anyway.
   */
  viewportProps?: React.ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.Viewport> & {
    ref?:
      ((instance: HTMLDivElement | null) => void) | React.RefObject<HTMLDivElement | null> | null;
  };
  viewportRef?: React.Ref<HTMLDivElement>;
};

/**
 * Both ref channels must reach the viewport node: extend's viewers pass their
 * own `ref` inside `viewportProps` (the xlsx grid's scroll/paint pipeline
 * dead-locks at 0×0 if it never attaches) while callers also pass a separate
 * `viewportRef` for toolbar scroll actions. A plain `ref={viewportRef}` after
 * the spread silently discards the former.
 */
export function mergeRefs<T>(
  ...refs: Array<React.Ref<T> | null | undefined>
): React.RefCallback<T> {
  return (node) => {
    for (const ref of refs) {
      if (!ref) continue;
      if (typeof ref === 'function') ref(node);
      else (ref as React.MutableRefObject<T | null>).current = node;
    }
  };
}

export function ScrollArea({
  className,
  children,
  orientation = 'both',
  scrollFade: _scrollFade,
  scrollbarGutter: _scrollbarGutter,
  viewportClassName,
  viewportProps,
  viewportRef,
  ...props
}: ScrollAreaCompatProps) {
  const {
    className: viewportPropsClassName,
    ref: viewportPropsRef,
    ...restViewportProps
  } = viewportProps ?? {};

  const mergedViewportRef = React.useMemo(
    () => mergeRefs<HTMLDivElement>(viewportPropsRef, viewportRef),
    [viewportPropsRef, viewportRef],
  );

  return (
    <ScrollAreaPrimitive.Root
      data-slot="scroll-area"
      className={cn('relative overflow-hidden', className)}
      {...props}
    >
      <ScrollAreaPrimitive.Viewport
        {...restViewportProps}
        ref={mergedViewportRef}
        data-slot="scroll-area-viewport"
        className={cn(
          'focus-visible:ring-ring/50 size-full rounded-[inherit] transition-[color,box-shadow] outline-none focus-visible:ring-[3px] focus-visible:outline-1',
          viewportPropsClassName,
          viewportClassName,
        )}
      >
        {children}
      </ScrollAreaPrimitive.Viewport>
      {orientation !== 'horizontal' ? <ScrollBar orientation="vertical" /> : null}
      {orientation !== 'vertical' ? <ScrollBar orientation="horizontal" /> : null}
      {orientation === 'both' ? <ScrollAreaPrimitive.Corner /> : null}
    </ScrollAreaPrimitive.Root>
  );
}

function ScrollBar({
  className,
  orientation = 'vertical',
  ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.Scrollbar>) {
  return (
    <ScrollAreaPrimitive.Scrollbar
      data-slot="scroll-area-scrollbar"
      orientation={orientation}
      className={cn(
        'flex touch-none p-px select-none opacity-0 transition-opacity duration-moderate data-hovering:opacity-100 data-scrolling:opacity-100 data-scrolling:duration-0',
        orientation === 'vertical' && 'h-full w-2.5 border-l border-l-transparent',
        orientation === 'horizontal' && 'h-2.5 flex-col border-t border-t-transparent',
        className as string | undefined,
      )}
      {...props}
    >
      <ScrollAreaPrimitive.Thumb
        data-slot="scroll-area-thumb"
        className="bg-border relative flex-1 cursor-grab rounded-full active:cursor-grabbing"
      />
    </ScrollAreaPrimitive.Scrollbar>
  );
}
