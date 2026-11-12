import { Toggle as TogglePrimitive } from '@base-ui/react/toggle';
import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';

import { asChildRender, composeRefs, stateRender, useNativeButton } from '../lib/base-ui-compat';
import { cn } from '../lib/utils';

const toggleVariants = cva(
  'inline-flex items-center justify-center gap-2 rounded-md bg-transparent text-sm font-medium text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground focus-visible:outline-none focus-visible:ring-kortix-base focus-visible:ring-[0.6px] disabled:pointer-events-none disabled:opacity-50 data-[state=on]:bg-primary/10 data-[state=on]:text-primary data-[state=on]:hover:bg-primary/[0.14] [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: '',
        outline: 'border border-border data-[state=on]:border-primary/25',
        secondary:
          'bg-foreground/[0.05] text-foreground/70 hover:bg-foreground/[0.08] hover:text-foreground',
      },
      size: {
        default: 'h-9 px-3 ',
        sm: 'h-8 px-3',
        lg: 'h-10 px-2.5 min-w-10',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

type ToggleProps = Omit<React.ComponentPropsWithoutRef<'button'>, 'value'> &
  VariantProps<typeof toggleVariants> & {
    pressed?: boolean;
    defaultPressed?: boolean;
    onPressedChange?: (pressed: boolean) => void;
    value?: string;
    asChild?: boolean;
  };

const Toggle = React.forwardRef<HTMLButtonElement, ToggleProps>(
  ({ className, variant, size, asChild, children, onPressedChange, ...props }, ref) => {
    const slot = asChildRender(asChild, children);
    const native = useNativeButton(asChild, children);
    return (
      <TogglePrimitive
        ref={composeRefs(ref, native.ref)}
        className={cn(toggleVariants({ variant, size, className }))}
        {...props}
        onPressedChange={(pressed) => onPressedChange?.(pressed)}
        nativeButton={native.nativeButton}
        render={stateRender(
          'button',
          (s: { pressed: boolean }) => (s.pressed ? 'on' : 'off'),
          slot.render,
        )}
      >
        {slot.children}
      </TogglePrimitive>
    );
  },
);

Toggle.displayName = 'Toggle';

export { Toggle, toggleVariants };
export type { ToggleProps };
