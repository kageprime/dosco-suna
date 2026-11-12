'use client';

import { Tooltip as TooltipPrimitive } from '@base-ui/react/tooltip';
import * as React from 'react';

import {
  asChildRender,
  splitPosition,
  stateRender,
  type LegacyPositionProps,
  FLOATING_LAYER_ATTR,
} from '../lib/base-ui-compat';
import { withPortalContainer } from '../lib/portal-container';
import { cn } from '../lib/utils';

const TooltipPortal = withPortalContainer(TooltipPrimitive.Portal);

// `delayed-open` is the open value Radix gave a tooltip that opened on hover.
const tooltipState = (s: { open?: boolean }) => (s.open ? 'delayed-open' : 'closed');

/** The hover delay, set on `Tooltip` (per tooltip) or `TooltipProvider` (for a subtree). */
const TooltipDelayContext = React.createContext<number | undefined>(undefined);

// Radix's defaults, kept so an unconfigured tooltip opens as it did.
const DEFAULT_DELAY = 700;
const DEFAULT_SKIP_DELAY = 300;

function TooltipProvider({
  delayDuration,
  skipDelayDuration,
  children,
}: {
  delayDuration?: number;
  skipDelayDuration?: number;
  /** Accepted for Radix parity; Base UI popups are hoverable unless the root disables it. */
  disableHoverableContent?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <TooltipPrimitive.Provider
      delay={delayDuration ?? DEFAULT_DELAY}
      timeout={skipDelayDuration ?? DEFAULT_SKIP_DELAY}
    >
      <TooltipDelayContext.Provider value={delayDuration}>{children}</TooltipDelayContext.Provider>
    </TooltipPrimitive.Provider>
  );
}

export interface TooltipProps {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  delayDuration?: number;
  disableHoverableContent?: boolean;
  children?: React.ReactNode;
}

/** @deprecated In feature code use `Hint` (`@kortix/ui/hint`). `Tooltip` is the primitive `Hint` builds on. */
function Tooltip({
  open,
  defaultOpen,
  onOpenChange,
  delayDuration,
  disableHoverableContent,
  children,
}: TooltipProps) {
  const inherited = React.useContext(TooltipDelayContext);
  return (
    <TooltipPrimitive.Root
      open={open}
      defaultOpen={defaultOpen}
      onOpenChange={onOpenChange ? (next) => onOpenChange(next) : undefined}
      disableHoverablePopup={disableHoverableContent}
    >
      <TooltipDelayContext.Provider value={delayDuration ?? inherited}>
        {children}
      </TooltipDelayContext.Provider>
    </TooltipPrimitive.Root>
  );
}

const TooltipTrigger = React.forwardRef<
  HTMLButtonElement,
  React.ComponentPropsWithoutRef<'button'> & { asChild?: boolean }
>(({ asChild, children, ...props }, ref) => {
  const delay = React.useContext(TooltipDelayContext);
  const slot = asChildRender(asChild, children);
  return (
    <TooltipPrimitive.Trigger
      ref={ref}
      delay={delay ?? DEFAULT_DELAY}
      {...props}
      render={stateRender('button', tooltipState, slot.render)}
    >
      {slot.children}
    </TooltipPrimitive.Trigger>
  );
});
TooltipTrigger.displayName = 'TooltipTrigger';

/** @deprecated In feature code use `Hint` (`@kortix/ui/hint`). */
const TooltipContent = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<'div'> &
    LegacyPositionProps & { asChild?: boolean; forceMount?: true }
>(({ className, sideOffset = 4, asChild, forceMount, children, ...rest }, ref) => {
  const { positioner, rest: props } = splitPosition({ sideOffset, ...rest });
  const slot = asChildRender(asChild, children);
  return (
    <TooltipPortal keepMounted={forceMount}>
      <TooltipPrimitive.Positioner {...positioner} {...FLOATING_LAYER_ATTR} className="z-[9999]">
        <TooltipPrimitive.Popup
          ref={ref}
          data-slot="tooltip-content"
          // No enter/exit animation, the same as the dropdown, select and popover
          // panels: the tooltip paints on the frame it mounts and unmounts on the
          // frame it closes. The hover delay lives on `TooltipProvider`, not here.
          className={cn(
            'bg-foreground text-background ring-foreground/5 z-[9999] overflow-hidden rounded-sm p-1 px-2 text-[length:var(--text-xs,0.8125rem)] ring-[1px]',
            className,
          )}
          {...props}
          render={stateRender('div', tooltipState, slot.render)}
        >
          {slot.children}
        </TooltipPrimitive.Popup>
      </TooltipPrimitive.Positioner>
    </TooltipPortal>
  );
});
TooltipContent.displayName = 'TooltipContent';

export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger };
