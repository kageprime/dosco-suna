'use client';

import { Collapsible as CollapsiblePrimitive } from '@base-ui/react/collapsible';
import * as React from 'react';

import {
  asChildRender,
  composeRefs,
  openState,
  stateRender,
  useNativeButton,
} from '../lib/base-ui-compat';
import { cn } from '../lib/utils';

interface CollapsibleProps extends Omit<React.ComponentPropsWithoutRef<'div'>, 'onChange'> {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  disabled?: boolean;
  asChild?: boolean;
}

function Collapsible({ asChild, children, onOpenChange, ...props }: CollapsibleProps) {
  const slot = asChildRender(asChild, children);
  return (
    <CollapsiblePrimitive.Root
      data-slot="collapsible"
      {...props}
      onOpenChange={onOpenChange ? (open) => onOpenChange(open) : undefined}
      render={stateRender('div', openState, slot.render)}
    >
      {slot.children}
    </CollapsiblePrimitive.Root>
  );
}

function CollapsibleTrigger({
  className,
  asChild,
  children,
  ...props
}: React.ComponentPropsWithoutRef<'button'> & { asChild?: boolean }) {
  const slot = asChildRender(asChild, children);
  const native = useNativeButton(asChild, children);
  return (
    <CollapsiblePrimitive.Trigger
      data-slot="collapsible-trigger"
      {...props}
      ref={composeRefs((props as { ref?: React.Ref<HTMLButtonElement> }).ref, native.ref)}
      className={cn('cursor-pointer', className)}
      render={stateRender('button', openState, slot.render)}
      nativeButton={native.nativeButton}
    >
      {slot.children}
    </CollapsiblePrimitive.Trigger>
  );
}

function CollapsibleContent({
  className,
  asChild,
  children,
  forceMount,
  style,
  ...props
}: React.ComponentPropsWithoutRef<'div'> & { asChild?: boolean; forceMount?: true }) {
  const slot = asChildRender(asChild, children);
  return (
    <CollapsiblePrimitive.Panel
      data-slot="collapsible-content"
      {...props}
      keepMounted={forceMount}
      className={cn(
        'data-[state=open]:animate-collapsible-down data-[state=closed]:animate-collapsible-up overflow-hidden',
        className,
      )}
      // The keyframes in theme.css read the Radix variable name.
      style={
        {
          '--radix-collapsible-content-height': 'var(--collapsible-panel-height)',
          '--radix-collapsible-content-width': 'var(--collapsible-panel-width)',
          ...style,
        } as React.CSSProperties
      }
      render={stateRender('div', openState, slot.render)}
    >
      {slot.children}
    </CollapsiblePrimitive.Panel>
  );
}

export { Collapsible, CollapsibleContent, CollapsibleTrigger };
