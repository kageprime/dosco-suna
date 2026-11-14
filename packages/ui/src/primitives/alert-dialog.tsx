'use client';

import { AlertDialog as AlertDialogPrimitive } from '@base-ui/react/alert-dialog';
import * as React from 'react';

import {
  asChildRender,
  composeRefs,
  DismissProvider,
  focusProps,
  openState,
  stateRender,
  useDismissContent,
  useDismissRoot,
  useNativeButton,
  type DismissHandlers,
} from '../lib/base-ui-compat';
import { usePortalContainer } from '../lib/portal-container';
import { cn } from '../lib/utils';
import {
  dialogContentZ,
  DialogDepthProvider,
  dialogOverlayZ,
  useDialogDepth,
  useDialogRootLayer,
} from '../lib/z-stack';
import { ButtonProps, buttonVariants } from './button';

type ButtonLikeProps = Omit<React.ComponentProps<'button'>, 'size'> & { asChild?: boolean };

export interface AlertDialogProps {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  children?: React.ReactNode;
}

// Depth follows the runtime layer stack, so an alert stacks above whatever is
// open even when it is rendered as a sibling. Still prefer rendering an alert
// that confirms for a dialog INSIDE that dialog's React tree: React events from
// the alert then bubble through the dialog, so the dialog's own outside-click
// and focus handlers never see the alert as "outside".
function AlertDialog({ children, open, defaultOpen, onOpenChange }: AlertDialogProps) {
  const layer = useDialogRootLayer({ open, defaultOpen, onOpenChange });
  const dismiss = useDismissRoot(layer.onOpenChange);
  return (
    <DialogDepthProvider depth={layer.depth}>
      <DismissProvider kind="dialog" registry={dismiss.registry}>
        <AlertDialogPrimitive.Root open={layer.open} onOpenChange={dismiss.onOpenChange}>
          {children}
        </AlertDialogPrimitive.Root>
      </DismissProvider>
    </DialogDepthProvider>
  );
}

function AlertDialogTrigger({ asChild, children, ...props }: ButtonLikeProps) {
  const slot = asChildRender(asChild, children);
  const native = useNativeButton(asChild, children);
  return (
    <AlertDialogPrimitive.Trigger
      data-slot="alert-dialog-trigger"
      {...props}
      ref={composeRefs((props as { ref?: React.Ref<HTMLButtonElement> }).ref, native.ref)}
      render={stateRender('button', openState, slot.render)}
      nativeButton={native.nativeButton}
    >
      {slot.children}
    </AlertDialogPrimitive.Trigger>
  );
}

function AlertDialogPortal({
  container,
  forceMount,
  children,
}: {
  container?: HTMLElement | null;
  forceMount?: true;
  children?: React.ReactNode;
}) {
  const scoped = usePortalContainer();
  return (
    <AlertDialogPrimitive.Portal
      data-slot="alert-dialog-portal"
      container={container ?? scoped}
      keepMounted={forceMount}
    >
      {children}
    </AlertDialogPrimitive.Portal>
  );
}

function AlertDialogOverlay({ className, style, ...props }: React.ComponentProps<'div'>) {
  const depth = useDialogDepth();
  return (
    <AlertDialogPrimitive.Backdrop
      forceRender
      data-slot="alert-dialog-overlay"
      className={cn(
        'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed inset-0 bg-black/65 backdrop-blur-xs',
        className,
      )}
      style={{ zIndex: dialogOverlayZ(depth), ...style }}
      render={stateRender('div', openState)}
      {...props}
    />
  );
}

type AlertDialogContentProps = React.ComponentProps<'div'> &
  Omit<DismissHandlers, 'onPointerDownOutside' | 'onInteractOutside' | 'onFocusOutside'> & {
    asChild?: boolean;
    forceMount?: true;
    overlayClassName?: string;
    onOpenAutoFocus?: (event: Event) => void;
    onCloseAutoFocus?: (event: Event) => void;
  };

function AlertDialogContent({
  className,
  style,
  overlayClassName,
  asChild,
  forceMount,
  children,
  onEscapeKeyDown,
  onOpenAutoFocus,
  onCloseAutoFocus,
  ...props
}: AlertDialogContentProps) {
  const depth = useDialogDepth();
  useDismissContent('dialog', { onEscapeKeyDown });
  const popupRef = React.useRef<HTMLDivElement | null>(null);
  const slot = asChildRender(asChild, children);
  return (
    <AlertDialogPortal forceMount={forceMount}>
      <AlertDialogOverlay className={overlayClassName} />
      <AlertDialogPrimitive.Popup
        data-slot="alert-dialog-content"
        className={cn(
          'bg-sidebar border-muted/60 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 duration-moderate fixed top-[50%] left-[50%] grid w-full max-w-[calc(100%-2rem)] translate-x-[-50%] translate-y-[-50%] gap-4 space-y-5 rounded-xl border p-5 shadow-lg sm:max-w-md',
          className,
        )}
        style={{ zIndex: dialogContentZ(depth), ...style }}
        ref={popupRef}
        {...focusProps(() => popupRef.current, onOpenAutoFocus, onCloseAutoFocus)}
        {...props}
        render={stateRender('div', openState, slot.render)}
      >
        {slot.children}
      </AlertDialogPrimitive.Popup>
    </AlertDialogPortal>
  );
}

function AlertDialogHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="alert-dialog-header"
      className={cn('flex flex-col gap-2 text-center sm:text-left', className)}
      {...props}
    />
  );
}

function AlertDialogFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="alert-dialog-footer"
      className={cn('flex flex-col-reverse gap-2 sm:flex-row sm:justify-end', className)}
      {...props}
    />
  );
}

function AlertDialogTitle({
  className,
  asChild,
  children,
  ...props
}: React.ComponentProps<'h2'> & { asChild?: boolean }) {
  return (
    <AlertDialogPrimitive.Title
      data-slot="alert-dialog-title"
      className={cn('text-lg font-medium', className)}
      {...props}
      {...asChildRender(asChild, children)}
    />
  );
}

function AlertDialogDescription({
  className,
  asChild,
  children,
  ...props
}: React.ComponentProps<'p'> & { asChild?: boolean }) {
  return (
    <AlertDialogPrimitive.Description
      data-slot="alert-dialog-description"
      className={cn(
        'text-muted-foreground text-[length:var(--text-md,0.9rem)] leading-snug',
        className,
      )}
      {...props}
      {...asChildRender(asChild, children)}
    />
  );
}

/**
 * A button that closes the alert. As with Radix, an `onClick` that calls
 * `preventDefault()` keeps the alert open (an async confirm closes it itself).
 */
function AlertDialogClose({ asChild, children, onClick, ...props }: ButtonLikeProps) {
  const slot = asChildRender(asChild, children);
  const native = useNativeButton(asChild, children);
  return (
    <AlertDialogPrimitive.Close
      {...props}
      ref={composeRefs((props as { ref?: React.Ref<HTMLButtonElement> }).ref, native.ref)}
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented) {
          (event as { preventBaseUIHandler?: () => void }).preventBaseUIHandler?.();
        }
      }}
      render={slot.render}
      nativeButton={native.nativeButton}
    >
      {slot.children}
    </AlertDialogPrimitive.Close>
  );
}

function AlertDialogAction({
  className,
  variant,
  ...props
}: ButtonLikeProps & {
  variant?: ButtonProps['variant'];
}) {
  return (
    <AlertDialogClose
      className={cn(buttonVariants({ size: 'sm', variant }), className)}
      {...props}
    />
  );
}

function AlertDialogCancel({ className, ...props }: ButtonLikeProps) {
  return (
    <AlertDialogClose
      className={cn(buttonVariants({ variant: 'outline-ghost', size: 'sm' }), className)}
      {...props}
    />
  );
}

export {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogOverlay,
  AlertDialogPortal,
  AlertDialogTitle,
  AlertDialogTrigger,
};
