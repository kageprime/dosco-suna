'use client';

import { Drawer as DrawerPrimitive } from '@base-ui/react/drawer';
import * as React from 'react';

import {
  asChildRender,
  composeRefs,
  openState,
  stateRender,
  useNativeButton,
} from '../lib/base-ui-compat';
import { usePortalContainer } from '../lib/portal-container';
import { cn } from '../lib/utils';

type DrawerDirection = 'top' | 'bottom' | 'left' | 'right';

const SWIPE: Record<DrawerDirection, 'up' | 'down' | 'left' | 'right'> = {
  top: 'up',
  bottom: 'down',
  left: 'left',
  right: 'right',
};

const DrawerDirectionContext = React.createContext<DrawerDirection>('bottom');

export interface DrawerProps {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** The edge the drawer slides in from. Swiping back toward it dismisses the drawer. */
  direction?: DrawerDirection;
  modal?: boolean;
  children?: React.ReactNode;
}

function Drawer({
  open,
  defaultOpen,
  onOpenChange,
  direction = 'bottom',
  modal,
  children,
}: DrawerProps) {
  return (
    <DrawerDirectionContext.Provider value={direction}>
      <DrawerPrimitive.Root
        data-slot="drawer"
        open={open}
        defaultOpen={defaultOpen}
        onOpenChange={onOpenChange ? (next) => onOpenChange(next) : undefined}
        swipeDirection={SWIPE[direction]}
        modal={modal}
      >
        {children}
      </DrawerPrimitive.Root>
    </DrawerDirectionContext.Provider>
  );
}

type ButtonLikeProps = React.ComponentProps<'button'> & { asChild?: boolean };

function DrawerTrigger({ asChild, children, ...props }: ButtonLikeProps) {
  const slot = asChildRender(asChild, children);
  const native = useNativeButton(asChild, children);
  return (
    <DrawerPrimitive.Trigger
      data-slot="drawer-trigger"
      {...props}
      ref={composeRefs((props as { ref?: React.Ref<HTMLButtonElement> }).ref, native.ref)}
      render={stateRender('button', openState, slot.render)}
      nativeButton={native.nativeButton}
    >
      {slot.children}
    </DrawerPrimitive.Trigger>
  );
}

function DrawerPortal({
  container,
  children,
}: {
  container?: HTMLElement | null;
  children?: React.ReactNode;
}) {
  const scoped = usePortalContainer();
  return (
    <DrawerPrimitive.Portal data-slot="drawer-portal" container={container ?? scoped}>
      {children}
    </DrawerPrimitive.Portal>
  );
}

function DrawerClose({ asChild, children, ...props }: ButtonLikeProps) {
  const slot = asChildRender(asChild, children);
  const native = useNativeButton(asChild, children);
  return (
    <DrawerPrimitive.Close
      data-slot="drawer-close"
      {...props}
      ref={composeRefs((props as { ref?: React.Ref<HTMLButtonElement> }).ref, native.ref)}
      render={slot.render}
      nativeButton={native.nativeButton}
    >
      {slot.children}
    </DrawerPrimitive.Close>
  );
}

function DrawerOverlay({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <DrawerPrimitive.Backdrop
      data-slot="drawer-overlay"
      className={cn(
        'duration-moderate fixed inset-0 z-50 bg-black/50 opacity-[calc(1-var(--drawer-swipe-progress,0))] transition-opacity ease-out data-ending-style:opacity-0 data-starting-style:opacity-0 data-swiping:duration-0',
        className,
      )}
      render={stateRender('div', openState)}
      {...props}
    />
  );
}

/**
 * Slide-in per edge. The swipe offset Base UI writes while the drawer is
 * dragged moves the panel with the finger.
 */
const DRAWER_MOTION: Record<DrawerDirection, string> = {
  top: '[transform:translateY(var(--drawer-swipe-movement-y,0px))] data-starting-style:[transform:translateY(-100%)] data-ending-style:[transform:translateY(-100%)]',
  bottom:
    '[transform:translateY(var(--drawer-swipe-movement-y,0px))] data-starting-style:[transform:translateY(100%)] data-ending-style:[transform:translateY(100%)]',
  left: '[transform:translateX(var(--drawer-swipe-movement-x,0px))] data-starting-style:[transform:translateX(-100%)] data-ending-style:[transform:translateX(-100%)]',
  right:
    '[transform:translateX(var(--drawer-swipe-movement-x,0px))] data-starting-style:[transform:translateX(100%)] data-ending-style:[transform:translateX(100%)]',
};

function DrawerContent({
  className,
  children,
  bar = true,
  ...props
}: React.ComponentProps<'div'> & {
  bar?: boolean;
}) {
  const direction = React.useContext(DrawerDirectionContext);
  return (
    <DrawerPortal>
      <DrawerOverlay />
      {/* Base UI handles swipe-to-dismiss and touch scroll locking in the viewport. */}
      <DrawerPrimitive.Viewport className="fixed inset-0 z-50">
        <DrawerPrimitive.Popup
          data-slot="drawer-content"
          // The vaul attribute, kept: callers and the classes below style by it.
          data-vaul-drawer-direction={direction}
          className={cn(
            'group/drawer-content bg-background duration-moderate fixed z-50 flex h-auto flex-col transition-transform ease-out outline-none data-swiping:duration-0 data-swiping:select-none',
            DRAWER_MOTION[direction],
            'data-[vaul-drawer-direction=top]:inset-x-0 data-[vaul-drawer-direction=top]:top-0 data-[vaul-drawer-direction=top]:mb-24 data-[vaul-drawer-direction=top]:max-h-[80vh] data-[vaul-drawer-direction=top]:rounded-b-lg data-[vaul-drawer-direction=top]:border-b',
            'data-[vaul-drawer-direction=bottom]:inset-x-0 data-[vaul-drawer-direction=bottom]:bottom-0 data-[vaul-drawer-direction=bottom]:mt-24 data-[vaul-drawer-direction=bottom]:max-h-[80vh] data-[vaul-drawer-direction=bottom]:rounded-t-lg data-[vaul-drawer-direction=bottom]:border-t',
            'data-[vaul-drawer-direction=right]:inset-y-0 data-[vaul-drawer-direction=right]:right-0 data-[vaul-drawer-direction=right]:w-3/4 data-[vaul-drawer-direction=right]:border-l data-[vaul-drawer-direction=right]:sm:max-w-sm',
            'data-[vaul-drawer-direction=left]:inset-y-0 data-[vaul-drawer-direction=left]:left-0 data-[vaul-drawer-direction=left]:w-3/4 data-[vaul-drawer-direction=left]:border-r data-[vaul-drawer-direction=left]:sm:max-w-sm',
            className,
          )}
          render={stateRender('div', openState)}
          {...props}
        >
          {bar && (
            <div className="bg-muted mx-auto mt-4 hidden h-2 w-[100px] shrink-0 rounded-full group-data-[vaul-drawer-direction=bottom]/drawer-content:block" />
          )}
          {children}
        </DrawerPrimitive.Popup>
      </DrawerPrimitive.Viewport>
    </DrawerPortal>
  );
}

function DrawerHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="drawer-header"
      className={cn('flex flex-col gap-1.5 p-4', className)}
      {...props}
    />
  );
}

function DrawerFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="drawer-footer"
      className={cn('mt-auto flex flex-col gap-2 p-4', className)}
      {...props}
    />
  );
}

function DrawerTitle({
  className,
  asChild,
  children,
  ...props
}: React.ComponentProps<'h2'> & { asChild?: boolean }) {
  return (
    <DrawerPrimitive.Title
      data-slot="drawer-title"
      className={cn('text-foreground font-semibold', className)}
      {...props}
      {...asChildRender(asChild, children)}
    />
  );
}

function DrawerDescription({
  className,
  asChild,
  children,
  ...props
}: React.ComponentProps<'p'> & { asChild?: boolean }) {
  return (
    <DrawerPrimitive.Description
      data-slot="drawer-description"
      className={cn('text-muted-foreground text-sm', className)}
      {...props}
      {...asChildRender(asChild, children)}
    />
  );
}

export {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerOverlay,
  DrawerPortal,
  DrawerTitle,
  DrawerTrigger,
};
