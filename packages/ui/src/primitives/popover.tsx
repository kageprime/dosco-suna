'use client';

import { Popover as PopoverPrimitive } from '@base-ui/react/popover';
import * as React from 'react';

import {
  asChildRender,
  composeRefs,
  FLOATING_LAYER_ATTR,
  focusProps,
  openState,
  radixPositionVars,
  splitPosition,
  stateRender,
  useDismissRoot,
  useNativeButton,
  type DismissHandlers,
  type LegacyPositionProps,
} from '../lib/base-ui-compat';
import { usePortalContainer } from '../lib/portal-container';
import { cn } from '../lib/utils';
import { floatingZ, useDialogDepth } from '../lib/z-stack';
import { FLOATING_PANEL_SURFACE } from './menu-recipe';
import { triggerVariants, type TriggerVariantProps } from './trigger-variants';

/**
 * The surface comes from `FLOATING_PANEL_SURFACE`, shared with the dropdown,
 * context menu and select — a popover is the same card, so it should not have
 * its own background, border, radius or shadow.
 *
 * No enter/exit animation, the same as `DropdownMenuContent`: the panel paints
 * on the frame it mounts and unmounts on the frame it closes. See
 * `dropdown-menu.tsx` for why.
 *
 * What stays local is what a popover holds rather than what it is: `p-4`
 * because the content is prose and controls rather than a list of `p-1` rows,
 * a `w-72` default, and `outline-hidden` because the popover focuses the panel
 * itself on open and the ring would trace the whole card.
 */
const POPOVER_PANEL = cn(FLOATING_PANEL_SURFACE, 'w-72 p-4 outline-hidden');

type Anchor = Element | { getBoundingClientRect(): DOMRect } | null;

/**
 * The popover's own context: its anchor and its dismiss registry. Its own,
 * not the shared `DismissProvider`, so a `PopoverContent` rendered inside a
 * nested hover card or menu root still reaches this popover.
 */
const PopoverAnchorContext = React.createContext<{
  anchor: Anchor;
  setAnchor: (anchor: Anchor) => void;
  dismiss: React.MutableRefObject<DismissHandlers>;
} | null>(null);

export interface PopoverProps {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  modal?: boolean;
  children?: React.ReactNode;
}

function Popover({ open, defaultOpen, onOpenChange, modal, children }: PopoverProps) {
  const dismiss = useDismissRoot(onOpenChange);
  const [anchor, setAnchor] = React.useState<Anchor>(null);
  const registry = dismiss.registry;
  const anchorValue = React.useMemo(
    () => ({ anchor, setAnchor, dismiss: registry }),
    [anchor, registry],
  );
  return (
    <PopoverAnchorContext.Provider value={anchorValue}>
      <PopoverPrimitive.Root
        data-slot="popover"
        open={open}
        defaultOpen={defaultOpen}
        onOpenChange={dismiss.onOpenChange}
        modal={modal}
      >
        {children}
      </PopoverPrimitive.Root>
    </PopoverAnchorContext.Provider>
  );
}

type PopoverTriggerProps = Omit<React.ComponentProps<'button'>, 'size'> &
  TriggerVariantProps & { asChild?: boolean };

function PopoverTrigger({
  className,
  variant,
  size,
  asChild,
  children,
  ...props
}: PopoverTriggerProps) {
  const slot = asChildRender(asChild, children);
  const native = useNativeButton(asChild, children);
  return (
    <PopoverPrimitive.Trigger
      data-slot="popover-trigger"
      {...props}
      ref={composeRefs((props as { ref?: React.Ref<HTMLButtonElement> }).ref, native.ref)}
      // With `asChild` the child owns its styling — merging ours would double it.
      className={asChild ? className : cn(triggerVariants({ variant, size }), className)}
      render={stateRender('button', openState, slot.render)}
      nativeButton={native.nativeButton}
    >
      {slot.children}
    </PopoverPrimitive.Trigger>
  );
}

export type PopoverContentProps = React.ComponentProps<'div'> &
  LegacyPositionProps &
  DismissHandlers & {
    asChild?: boolean;
    container?: HTMLElement;
    forceMount?: true;
    onOpenAutoFocus?: (event: Event) => void;
    onCloseAutoFocus?: (event: Event) => void;
  };

function PopoverContent({
  className,
  align = 'center',
  sideOffset = 4,
  container,
  style,
  asChild,
  forceMount,
  children,
  onEscapeKeyDown,
  onPointerDownOutside,
  onFocusOutside,
  onInteractOutside,
  onOpenAutoFocus,
  onCloseAutoFocus,
  ref,
  ...rest
}: PopoverContentProps) {
  const depth = useDialogDepth();
  const scoped = usePortalContainer();
  const anchorCtx = React.useContext(PopoverAnchorContext);
  const dismiss = anchorCtx?.dismiss;
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
  const popupRef = React.useRef<HTMLDivElement | null>(null);
  const composedPopupRef = React.useMemo(() => composeRefs(popupRef, ref), [ref]);
  return (
    <PopoverPrimitive.Portal container={container ?? scoped} keepMounted={forceMount}>
      <PopoverPrimitive.Positioner
        {...FLOATING_LAYER_ATTR}
        {...positioner}
        {...(anchorCtx?.anchor ? { anchor: anchorCtx.anchor } : {})}
        style={{ zIndex: floatingZ(depth) }}
      >
        <PopoverPrimitive.Popup
          data-slot="popover-content"
          {...props}
          ref={composedPopupRef}
          {...focusProps(() => popupRef.current, onOpenAutoFocus, onCloseAutoFocus)}
          className={cn(POPOVER_PANEL, className)}
          style={{ ...radixPositionVars('popover'), ...style }}
          render={stateRender('div', openState, slot.render)}
        >
          {slot.children}
        </PopoverPrimitive.Popup>
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  );
}

/**
 * The element the content positions against instead of the trigger. With
 * `asChild` it is the child; `virtualRef` positions against a measurable
 * object (a caret, a pointer position) as Radix did.
 */
function PopoverAnchor({
  asChild,
  virtualRef,
  children,
  ref,
  ...props
}: React.ComponentProps<'div'> & {
  asChild?: boolean;
  virtualRef?: React.RefObject<{ getBoundingClientRect(): DOMRect } | null>;
}) {
  const ctx = React.useContext(PopoverAnchorContext);
  const setAnchor = ctx?.setAnchor;
  React.useLayoutEffect(() => {
    if (!virtualRef || !setAnchor) return;
    // A stable proxy: the ref's target may change between renders.
    setAnchor({
      getBoundingClientRect: () => virtualRef.current?.getBoundingClientRect() ?? new DOMRect(),
    });
    return () => setAnchor(null);
  }, [virtualRef, setAnchor]);
  const register = React.useCallback(
    (node: Element | null) => {
      if (!virtualRef) setAnchor?.(node);
    },
    [setAnchor, virtualRef],
  );
  const childRef =
    asChild && React.isValidElement(children)
      ? (children.props as { ref?: React.Ref<Element> }).ref
      : undefined;
  // Memoized: a new ref callback each render would detach and re-register the anchor.
  const composed = React.useMemo(
    () => composeRefs(childRef, register, ref as React.Ref<Element>),
    [childRef, register, ref],
  );
  if (virtualRef) return null;
  if (asChild && React.isValidElement(children)) {
    return React.cloneElement(children as React.ReactElement<{ ref?: React.Ref<Element> }>, {
      ...props,
      ref: composed,
    });
  }
  return (
    <div data-slot="popover-anchor" {...props} ref={composed}>
      {children}
    </div>
  );
}

export { Popover, PopoverAnchor, PopoverContent, PopoverTrigger };
