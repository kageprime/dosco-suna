'use client';

import { Dialog as SheetPrimitive } from '@base-ui/react/dialog';
import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';

import { Close } from '../icons/close';
import { asChildRender, openState, stateRender } from '../lib/base-ui-compat';
import { cn } from '../lib/utils';
import { useUiStrings } from '../providers/ui-provider';
import { dialogContentZ, dialogOverlayZ, useDialogDepth } from '../lib/z-stack';
import { buttonVariants } from './button';
import {
  Dialog,
  DialogClose,
  DialogPopup,
  DialogPortal,
  DialogTrigger,
  type DialogContentBaseProps,
} from './dialog';

// A sheet is a dialog that slides in from an edge: same root, trigger, close,
// portal and popup contract; only the surface and its motion differ.
const Sheet = Dialog;

const SheetTrigger = DialogTrigger;

const SheetClose = DialogClose;

const SheetPortal = DialogPortal;

const SheetOverlay = React.forwardRef<HTMLDivElement, React.ComponentPropsWithoutRef<'div'>>(
  ({ className, style, ...props }, ref) => {
    const depth = useDialogDepth();

    return (
      <SheetPrimitive.Backdrop
        forceRender
        className={cn(
          'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed inset-0 bg-black/80',
          className,
        )}
        style={{ zIndex: dialogOverlayZ(depth), ...style }}
        render={stateRender('div', openState)}
        {...props}
        ref={ref}
      />
    );
  },
);
SheetOverlay.displayName = 'SheetOverlay';

const sheetVariants = cva(
  'fixed flex min-h-0 flex-col gap-4 overflow-hidden bg-sidebar p-4 shadow-lg transition ease-in-out data-[state=open]:animate-in data-[state=closed]:animate-out h-[calc(100vh-1.4rem)]',
  {
    variants: {
      side: {
        top: 'inset-x-0 top-0 border-b-[1.5px] border-border/40 data-[state=closed]:slide-out-to-top data-[state=open]:slide-in-from-top',
        bottom:
          'inset-x-0 bottom-0 border-t-[1.5px] border-border/40 data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom',
        left: 'inset-y-0 left-0 h-full w-full md:w-3/4 border-r-[1.5px] border-border/40 data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left sm:max-w-sm',
        right:
          'inset-y-0 right-0 h-full md:h-[calc(100vh-1.4rem)] w-full md:w-3/4 border-[length:calc(var(--border-width,1px)*1.5)] md:rounded-lg border-border/40 data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right sm:max-w-sm md:m-[0.7rem]',
      },
    },
    defaultVariants: {
      side: 'right',
    },
  },
);

interface SheetContentProps extends DialogContentBaseProps, VariantProps<typeof sheetVariants> {
  showCloseButton?: boolean;
  overlayClassName?: string;
}

const SheetContent = React.forwardRef<HTMLDivElement, SheetContentProps>(
  (
    {
      side = 'right',
      className,
      children,
      showCloseButton = true,
      overlayClassName,
      style,
      forceMount,
      ...props
    },
    ref,
  ) => {
    const depth = useDialogDepth();
    const strings = useUiStrings();

    return (
      <SheetPortal keepMounted={forceMount}>
        <SheetOverlay className={overlayClassName} />
        <DialogPopup
          ref={ref}
          className={cn(sheetVariants({ side }), className)}
          style={{ zIndex: dialogContentZ(depth), ...style }}
          {...props}
        >
          {children}
          {showCloseButton && (
            <SheetPrimitive.Close
              className={cn(
                'absolute top-4 right-4',
                buttonVariants({ variant: 'ghost', size: 'icon' }),
              )}
            >
              <Close className="size-[1.15rem] stroke-0" />
              <span className="sr-only">{strings.close}</span>
            </SheetPrimitive.Close>
          )}
        </DialogPopup>
      </SheetPortal>
    );
  },
);
SheetContent.displayName = 'SheetContent';

const SheetHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn('flex shrink-0 flex-col space-y-2 text-center sm:text-left', className)}
    {...props}
  />
);
SheetHeader.displayName = 'SheetHeader';

const SheetFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      'flex shrink-0 flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2',
      className,
    )}
    {...props}
  />
);
SheetFooter.displayName = 'SheetFooter';

const SheetBody = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      'flex min-h-0 w-full flex-1 flex-col items-start justify-start gap-4 overflow-y-auto py-6',
      className,
    )}
    {...props}
  />
);
SheetBody.displayName = 'SheetBody';

const SheetTitle = React.forwardRef<
  HTMLHeadingElement,
  React.ComponentPropsWithoutRef<'h2'> & { asChild?: boolean }
>(({ className, asChild, children, ...props }, ref) => (
  <SheetPrimitive.Title
    {...asChildRender(asChild, children)}
    ref={ref}
    className={cn('text-foreground text-lg font-semibold', className)}
    {...props}
  />
));
SheetTitle.displayName = 'SheetTitle';

const SheetDescription = React.forwardRef<
  HTMLParagraphElement,
  React.ComponentPropsWithoutRef<'p'> & { asChild?: boolean }
>(({ className, asChild, children, ...props }, ref) => (
  <SheetPrimitive.Description
    {...asChildRender(asChild, children)}
    ref={ref}
    className={cn('text-muted-foreground text-sm', className)}
    {...props}
  />
));
SheetDescription.displayName = 'SheetDescription';

export {
  Sheet,
  SheetBody,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetOverlay,
  SheetPortal,
  SheetTitle,
  SheetTrigger,
};
