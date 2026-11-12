'use client';

import { Radio as RadioPrimitive } from '@base-ui/react/radio';
import { RadioGroup as RadioGroupPrimitive } from '@base-ui/react/radio-group';
import * as React from 'react';

import { checkedState, controlRender, useLabelReentryGuard } from '../lib/base-ui-compat';
import { cn } from '../lib/utils';

type RadioGroupProps = Omit<React.ComponentProps<'div'>, 'defaultValue' | 'dir' | 'onChange'> & {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  name?: string;
  required?: boolean;
  disabled?: boolean;
  orientation?: 'horizontal' | 'vertical';
  /** Accepted for Radix parity; arrow keys always wrap. */
  loop?: boolean;
  dir?: 'ltr' | 'rtl';
};

function RadioGroup({
  className,
  onValueChange,
  orientation,
  loop: _loop,
  dir,
  ...props
}: RadioGroupProps) {
  return (
    <RadioGroupPrimitive
      data-slot="radio-group"
      data-orientation={orientation}
      aria-orientation={orientation}
      dir={dir}
      className={cn('grid gap-1', className)}
      {...(props as Omit<typeof props, 'ref'>)}
      onValueChange={(value) => onValueChange?.(value as string)}
    />
  );
}

/** A Radix-shaped radio item: a `<button>` with `data-state` checked/unchecked. */
type RadioGroupItemBaseProps = Omit<React.ComponentProps<'button'>, 'value' | 'ref'> & {
  value: string;
  required?: boolean;
  ref?: React.Ref<HTMLButtonElement>;
  /**
   * Wraps the rendered button, e.g. in its `<label>`. Base UI renders the
   * hidden input next to the root, so a wrapper here keeps it outside.
   */
  wrap?: (button: React.ReactElement) => React.ReactElement;
};

const renderRadio = controlRender(checkedState);

function RadioGroupItemBase({ id, children, wrap, ...props }: RadioGroupItemBaseProps) {
  const onClick = useLabelReentryGuard(props.onClick);
  return (
    <RadioPrimitive.Root
      // The root renders a <button> (`nativeButton`), so button props are right at runtime.
      {...(props as unknown as React.ComponentProps<typeof RadioPrimitive.Root>)}
      onClick={onClick}
      id={id}
      nativeButton
      render={wrap ? (buttonProps, state) => wrap(renderRadio(buttonProps, state)) : renderRadio}
    >
      {children}
    </RadioPrimitive.Root>
  );
}

type RadioGroupItemProps = RadioGroupItemBaseProps & {
  label?: React.ReactNode;
  description?: React.ReactNode;
  size?: 'sm' | 'md' | 'lg';
  variant?: 'default' | 'outline';
};

const radioControlClassName = cn(
  'peer aspect-square size-4 shrink-0 rounded-full border border-muted-foreground/60 bg-transparent',
  'transition-[color,box-shadow,border-color,background-color]',
  'outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
  'disabled:cursor-not-allowed disabled:opacity-50 data-disabled:cursor-not-allowed data-disabled:opacity-50',
  'data-[state=checked]:border-foreground data-[state=checked]:bg-background data-[state=checked]:border-kortix-blue data-[state=checked]:border-4 ',
  'aria-invalid:border-destructive',
);

function RadioGroupItem({
  className,
  label,
  description,
  id,
  disabled,
  size = 'md',
  variant = 'default',
  ...props
}: RadioGroupItemProps) {
  const generatedId = React.useId();
  const itemId = id ?? generatedId;
  const hasCaption = label != null || description != null;

  const wrap = hasCaption
    ? (button: React.ReactElement) => (
        <label
          className={cn(
            'flex w-full cursor-pointer gap-3 rounded-md px-3 py-1.5 transition-colors',
            description != null ? 'items-start justify-start' : 'items-center justify-center',
            'hover:bg-foreground/3',
            'has-data-[state=checked]:bg-foreground/6 has-data-[state=checked]:hover:bg-foreground/6',
            'has-focus-visible:ring-ring has-focus-visible:ring-offset-background has-focus-visible:ring-2 has-focus-visible:ring-offset-2',
            disabled && 'cursor-not-allowed opacity-50',
            className,
            size === 'sm' && 'px-2 py-1.5',
            size === 'md' && 'px-3 py-1.5',
            size === 'lg' && 'px-4 py-2.5',
            variant === 'outline' && 'border-border border',
          )}
        >
          {button}
          <div
            className={cn(
              'flex min-w-0 flex-1 flex-col',
              description != null ? 'justify-start' : 'justify-center',
            )}
          >
            {label != null && (
              <span
                className={cn(
                  'text-sm transition-[color,font-weight]',
                  'text-foreground',
                  'peer-data-[state=checked]:text-foreground peer-data-[state=checked]:font-medium',
                  disabled && 'text-muted-foreground',
                )}
              >
                {label}
              </span>
            )}
            {description != null && (
              <span
                data-slot="radio-group-item-description"
                className="text-muted-foreground block text-[length:var(--text-xs,0.8125rem)]"
              >
                {description}
              </span>
            )}
          </div>
        </label>
      )
    : undefined;

  return (
    <RadioGroupItemBase
      data-slot="radio-group-item"
      id={itemId}
      disabled={disabled}
      className={cn(
        radioControlClassName,
        !hasCaption && className,
        description != null && 'mt-[3px]',
      )}
      wrap={wrap}
      {...props}
    />
  );
}

export { RadioGroup, RadioGroupItem, RadioGroupItemBase };
export type { RadioGroupItemBaseProps, RadioGroupItemProps, RadioGroupProps };
