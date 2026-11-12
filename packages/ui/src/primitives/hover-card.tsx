'use client';

import { PreviewCard as HoverCardPrimitive } from '@base-ui/react/preview-card';
import * as React from 'react';

import {
  asChildRender,
  openState,
  radixPositionVars,
  splitPosition,
  stateRender,
  useDismissRoot,
  type DismissHandlers,
  type LegacyPositionProps,
  FLOATING_LAYER_ATTR,
} from '../lib/base-ui-compat';
import { withPortalContainer } from '../lib/portal-container';
import { cn } from '../lib/utils';
import { floatingZ, useDialogDepth } from '../lib/z-stack';
import { FLOATING_PANEL, FLOATING_PANEL_SURFACE } from './menu-recipe';

const HoverCardPortal = withPortalContainer(HoverCardPrimitive.Portal);

// Radix's defaults, kept so an unconfigured card opens and closes as it did.
const DEFAULT_OPEN_DELAY = 700;
const DEFAULT_CLOSE_DELAY = 300;

/**
 * The card's own context: its delays and its dismiss registry. Its own, not
 * the shared `DismissProvider`, so a content rendered inside a nested root of
 * another kind still reaches this card.
 */
const HoverCardContext = React.createContext<{
  openDelay: number;
  closeDelay: number;
  dismiss: React.MutableRefObject<DismissHandlers> | null;
}>({
  openDelay: DEFAULT_OPEN_DELAY,
  closeDelay: DEFAULT_CLOSE_DELAY,
  dismiss: null,
});

export interface HoverCardProps {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  openDelay?: number;
  closeDelay?: number;
  children?: React.ReactNode;
}

function HoverCard({
  open,
  defaultOpen,
  onOpenChange,
  openDelay = DEFAULT_OPEN_DELAY,
  closeDelay = DEFAULT_CLOSE_DELAY,
  children,
}: HoverCardProps) {
  const dismiss = useDismissRoot(onOpenChange);
  const registry = dismiss.registry;
  const value = React.useMemo(
    () => ({ openDelay, closeDelay, dismiss: registry }),
    [openDelay, closeDelay, registry],
  );
  return (
    <HoverCardContext.Provider value={value}>
      <HoverCardPrimitive.Root
        data-slot="hover-card"
        open={open}
        defaultOpen={defaultOpen}
        onOpenChange={dismiss.onOpenChange}
      >
        {children}
      </HoverCardPrimitive.Root>
    </HoverCardContext.Provider>
  );
}

function HoverCardTrigger({
  asChild,
  children,
  ...props
}: React.ComponentProps<'a'> & { asChild?: boolean }) {
  const { openDelay, closeDelay } = React.useContext(HoverCardContext);
  const slot = asChildRender(asChild, children);
  return (
    <HoverCardPrimitive.Trigger
      data-slot="hover-card-trigger"
      delay={openDelay}
      closeDelay={closeDelay}
      {...props}
      render={stateRender('a', openState, slot.render)}
    >
      {slot.children}
    </HoverCardPrimitive.Trigger>
  );
}

/**
 * The fifth panel to join `FLOATING_PANEL`.
 *
 * `menu-recipe.ts` reconciled the dropdown, context menu, select and popover
 * surfaces onto one description of "a hairline-bordered card lifted off the
 * canvas". This one was missed and kept its own `rounded-md` + `shadow-sm`,
 * so a hover card sat a step flatter and 2px tighter than every other floating
 * panel — which is why `token-progress.tsx` had to patch `shadow-md` back on at
 * its call site. The recipe owns the surface and the enter/exit now.
 *
 * Two things stay local because they are this primitive's own: the transform
 * origin (the variable is named per primitive) and the `motion-reduce`
 * guard, which no other panel ships and which must survive the move.
 *
 * `animated={false}` takes `FLOATING_PANEL_SURFACE` instead, the same split
 * `MENU_PANEL_STATIC` makes for submenus, and for the same reason: a panel that
 * opens INTO the path the pointer is already travelling spends its enter
 * animation moving content away from the cursor, which reads as the card
 * lagging behind the hand rather than as polish.
 */
function HoverCardContent({
  className,
  align = 'center',
  sideOffset = 4,
  animated = true,
  style,
  asChild,
  forceMount,
  children,
  onEscapeKeyDown,
  onPointerDownOutside,
  onFocusOutside,
  onInteractOutside,
  ...rest
}: React.ComponentProps<'div'> &
  LegacyPositionProps &
  DismissHandlers & {
    animated?: boolean;
    asChild?: boolean;
    forceMount?: true;
  }) {
  // Inside a dialog the card stacks above it, as a popover does (`floatingZ`).
  const depth = useDialogDepth();
  const { dismiss } = React.useContext(HoverCardContext);
  React.useLayoutEffect(() => {
    if (dismiss) {
      dismiss.current = {
        onEscapeKeyDown,
        onPointerDownOutside,
        onFocusOutside,
        onInteractOutside,
      };
    }
  });
  const { positioner, rest: props } = splitPosition({
    align,
    sideOffset,
    ...rest,
  });
  const slot = asChildRender(asChild, children);
  return (
    <HoverCardPortal data-slot="hover-card-portal" keepMounted={forceMount}>
      <HoverCardPrimitive.Positioner {...positioner} {...FLOATING_LAYER_ATTR} style={{ zIndex: floatingZ(depth) }}>
        <HoverCardPrimitive.Popup
          data-slot="hover-card-content"
          className={cn(
            animated ? FLOATING_PANEL : FLOATING_PANEL_SURFACE,
            'w-64 origin-(--radix-hover-card-content-transform-origin) p-4 outline-hidden motion-reduce:animate-none motion-reduce:transition-none',
            className,
          )}
          style={{ ...radixPositionVars('hover-card'), ...style }}
          {...props}
          render={stateRender('div', openState, slot.render)}
        >
          {slot.children}
        </HoverCardPrimitive.Popup>
      </HoverCardPrimitive.Positioner>
    </HoverCardPortal>
  );
}

export { HoverCard, HoverCardContent, HoverCardTrigger };
