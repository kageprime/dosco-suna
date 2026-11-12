'use client';

import { Dialog as DialogPrimitive } from '@base-ui/react/dialog';
import * as React from 'react';

import { cva, VariantProps } from 'class-variance-authority';
import { Close } from '../icons/close';
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
import { withPortalContainer } from '../lib/portal-container';
import { cn } from '../lib/utils';
import {
  dialogContentZ,
  DialogDepthProvider,
  dialogOverlayZ,
  useDialogDepth,
  useDialogRootLayer,
} from '../lib/z-stack';
import { useUiStrings } from '../providers/ui-provider';
import { buttonVariants } from './button';
import { triggerVariants, type TriggerVariantProps } from './trigger-variants';

export interface DialogProps {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  modal?: boolean;
  children?: React.ReactNode;
}

/** @deprecated In feature code use `Modal` (`@kortix/ui/modal`). `Dialog` is the primitive other components build on. */
const Dialog = ({ open, defaultOpen, onOpenChange, modal, children }: DialogProps) => {
  const layer = useDialogRootLayer({ open, defaultOpen, onOpenChange });
  const dismiss = useDismissRoot(layer.onOpenChange);

  return (
    <DialogDepthProvider depth={layer.depth}>
      <DismissProvider kind="dialog" registry={dismiss.registry}>
        <DialogPrimitive.Root open={layer.open} onOpenChange={dismiss.onOpenChange} modal={modal}>
          {children}
        </DialogPrimitive.Root>
      </DismissProvider>
    </DialogDepthProvider>
  );
};

type ButtonLikeProps = Omit<React.ComponentPropsWithoutRef<'button'>, 'size'> & {
  asChild?: boolean;
};

const DialogTrigger = React.forwardRef<HTMLButtonElement, ButtonLikeProps & TriggerVariantProps>(
  ({ className, variant, size, asChild, children, ...props }, ref) => {
    const slot = asChildRender(asChild, children);
    const native = useNativeButton(asChild, children);
    return (
      <DialogPrimitive.Trigger
        ref={composeRefs(ref, native.ref)}
        {...props}
        // With `asChild` the child owns its styling — merging ours would double it.
        className={asChild ? className : cn(triggerVariants({ variant, size }), className)}
        render={stateRender('button', openState, slot.render)}
        nativeButton={native.nativeButton}
      >
        {slot.children}
      </DialogPrimitive.Trigger>
    );
  },
);
DialogTrigger.displayName = 'DialogTrigger';

const DialogPortal = withPortalContainer(DialogPrimitive.Portal);

const DialogClose = React.forwardRef<HTMLButtonElement, ButtonLikeProps>(
  ({ asChild, children, ...props }, ref) => {
    const slot = asChildRender(asChild, children);
    const native = useNativeButton(asChild, children);
    return (
      <DialogPrimitive.Close
        ref={composeRefs(ref, native.ref)}
        {...props}
        render={slot.render}
        nativeButton={native.nativeButton}
      >
        {slot.children}
      </DialogPrimitive.Close>
    );
  },
);
DialogClose.displayName = 'DialogClose';

const DialogOverlay = React.forwardRef<HTMLDivElement, React.ComponentPropsWithoutRef<'div'>>(
  ({ className, style, ...props }, ref) => {
    const depth = useDialogDepth();

    return (
      <DialogPrimitive.Backdrop
        ref={ref}
        className={cn(
          'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 duration-moderate fixed inset-0 bg-black/65 backdrop-blur-xs',
          className,
        )}
        style={{ zIndex: dialogOverlayZ(depth), ...style }}
        render={stateRender('div', openState)}
        {...props}
      />
    );
  },
);
DialogOverlay.displayName = 'DialogOverlay';

const DialogVariants = cva(
  cn(
    'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 fixed top-[50%] left-[50%] grid w-full max-w-[calc(100%-2rem)] translate-x-[-50%] translate-y-[-50%] gap-4 border p-5 shadow-lg duration-moderate sm:max-w-lg sm:rounded-lg',
  ),
  {
    variants: {
      variant: {
        default: 'bg-sidebar border-muted/60',
        transparent: 'bg-transparent border-none p-0',
      },
    },
    defaultVariants: {
      variant: 'transparent',
    },
  },
);

/** The Radix `Content` props the dialog family still accepts. */
export type DialogContentBaseProps = React.ComponentPropsWithoutRef<'div'> &
  DismissHandlers & {
    asChild?: boolean;
    forceMount?: true;
    onOpenAutoFocus?: (event: Event) => void;
    onCloseAutoFocus?: (event: Event) => void;
  };

/**
 * The dialog popup with the Radix content contract: `data-state`, dismiss
 * handlers, auto-focus handlers and `forceMount`. `DialogContent`, `Sheet`,
 * `Modal` and `AlertDialog` build on it.
 */
const DialogPopup = React.forwardRef<HTMLDivElement, DialogContentBaseProps>(
  (
    {
      asChild,
      children,
      forceMount: _forceMount,
      onEscapeKeyDown,
      onPointerDownOutside,
      onFocusOutside,
      onInteractOutside,
      onOpenAutoFocus,
      onCloseAutoFocus,
      ...props
    },
    ref,
  ) => {
    useDismissContent('dialog', {
      onEscapeKeyDown,
      onPointerDownOutside,
      onFocusOutside,
      onInteractOutside,
    });
    const slot = asChildRender(asChild, children);
    const popupRef = React.useRef<HTMLDivElement | null>(null);
    return (
      <DialogPrimitive.Popup
        ref={composeRefs(ref, popupRef)}
        {...props}
        {...focusProps(() => popupRef.current, onOpenAutoFocus, onCloseAutoFocus)}
        render={stateRender('div', openState, slot.render)}
      >
        {slot.children}
      </DialogPrimitive.Popup>
    );
  },
);
DialogPopup.displayName = 'DialogPopup';

/** @deprecated In feature code use `ModalContent` (`@kortix/ui/modal`). */
const DialogContent = React.forwardRef<
  HTMLDivElement,
  DialogContentBaseProps &
    VariantProps<typeof DialogVariants> & {
      hideCloseButton?: boolean;
      showOverlay?: boolean;
      overlayClassName?: string;
    }
>(
  (
    {
      className,
      children,
      hideCloseButton = false,
      showOverlay = true,
      overlayClassName,
      style,
      forceMount,
      variant: _variant,
      ...props
    },
    ref,
  ) => {
    const depth = useDialogDepth();
    const strings = useUiStrings();

    return (
      <DialogPortal keepMounted={forceMount}>
        {showOverlay && <DialogOverlay className={overlayClassName} />}
        <DialogPopup
          ref={ref}
          className={cn(DialogVariants({ variant: 'default' }), className)}
          style={{ zIndex: dialogContentZ(depth), ...style }}
          {...props}
        >
          {children}
          {!hideCloseButton && (
            <DialogPrimitive.Close
              className={cn(
                buttonVariants({ variant: 'ghost', size: 'icon' }),
                'absolute top-3 right-3',
              )}
            >
              <Close className="h-4 w-4" />
              <span className="sr-only">{strings.close}</span>
            </DialogPrimitive.Close>
          )}
        </DialogPopup>
      </DialogPortal>
    );
  },
);
DialogContent.displayName = 'DialogContent';

const DialogHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('flex flex-col space-y-1.5 text-center sm:text-left', className)} {...props} />
);
DialogHeader.displayName = 'DialogHeader';

const DialogFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn('flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2', className)}
    {...props}
  />
);
DialogFooter.displayName = 'DialogFooter';

const DialogTitle = React.forwardRef<
  HTMLHeadingElement,
  React.ComponentPropsWithoutRef<'h2'> & { asChild?: boolean }
>(({ className, asChild, children, ...props }, ref) => (
  <DialogPrimitive.Title
    {...asChildRender(asChild, children)}
    ref={ref}
    className={cn('text-lg leading-none font-semibold tracking-tight', className)}
    {...props}
  />
));
DialogTitle.displayName = 'DialogTitle';

const DialogDescription = React.forwardRef<
  HTMLParagraphElement,
  React.ComponentPropsWithoutRef<'p'> & { asChild?: boolean }
>(({ className, asChild, children, ...props }, ref) => (
  <DialogPrimitive.Description
    {...asChildRender(asChild, children)}
    ref={ref}
    className={cn('text-muted-foreground text-sm', className)}
    {...props}
  />
));
DialogDescription.displayName = 'DialogDescription';

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPopup,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
};
