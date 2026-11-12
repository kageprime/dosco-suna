'use client';

import { Checkbox as CheckboxPrimitive } from '@base-ui/react/checkbox';
import * as React from 'react';

import { checkedState, useLabelReentryGuard } from '../lib/base-ui-compat';
import { cn } from '../lib/utils';

type CheckboxVariant = 'blue' | 'black';

/** Radix's checked state: a boolean, or `'indeterminate'` for a mixed box. */
type CheckedState = boolean | 'indeterminate';

type CheckboxProps = Omit<
  React.ComponentPropsWithoutRef<'button'>,
  'value' | 'checked' | 'defaultChecked' | 'onChange'
> & {
  checked?: CheckedState;
  defaultChecked?: CheckedState;
  /** A user toggle always reports a boolean; an indeterminate box becomes `true`. */
  onCheckedChange?: (checked: boolean) => void;
  name?: string;
  value?: string;
  required?: boolean;
  ref?: React.Ref<HTMLButtonElement>;
  label?: React.ReactNode;
  /** Fill of the checked box. `black` is the foreground ink, so it inverts in dark mode. */
  variant?: CheckboxVariant;
};

// One size everywhere: an 18px box, 6px corners, a round-capped check.
const checkboxControlClassName = cn(
  'peer flex size-[18px] shrink-0 items-center justify-center rounded-sm border-[length:calc(var(--border-width,1px)*1.5)] border-muted-foreground/60 bg-transparent text-background',
  'transition-[border-color,background-color]',
  'outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
  'disabled:cursor-default disabled:opacity-50', // cursor-default: disabled keeps the default cursor (AGENTS.md → States)
  'aria-invalid:border-destructive',
);

const checkboxVariantClassName: Record<CheckboxVariant, string> = {
  blue: 'data-[state=checked]:border-kortix-blue data-[state=checked]:bg-kortix-blue data-[state=indeterminate]:border-kortix-blue data-[state=indeterminate]:bg-kortix-blue',
  black:
    'data-[state=checked]:border-foreground data-[state=checked]:bg-foreground data-[state=indeterminate]:border-foreground data-[state=indeterminate]:bg-foreground',
};

function CheckMark({ indeterminate }: { indeterminate: boolean }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden className="size-3">
      <path
        d={indeterminate ? 'M4 8h8' : 'M3.5 8.5l3 3 6-7'}
        stroke="currentColor"
        strokeWidth={2.25}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * The checkbox `<button>`. The check mounts only while checked or
 * indeterminate, with no transition, as Radix's indicator did.
 */
function renderCheckbox(
  props: React.ComponentProps<'button'>,
  state: { checked: boolean; indeterminate: boolean; disabled: boolean },
) {
  const { disabled: _disabled, children: _children, ...rest } = props;
  const on = state.checked || state.indeterminate;
  return (
    <button {...rest} data-state={checkedState(state)} disabled={state.disabled || undefined}>
      {on && (
        <span
          data-slot="checkbox-indicator"
          data-state={checkedState(state)}
          className="flex items-center justify-center"
        >
          <CheckMark indeterminate={state.indeterminate} />
        </span>
      )}
    </button>
  );
}

function Checkbox({
  className,
  label,
  id,
  variant = 'blue',
  checked,
  defaultChecked,
  onCheckedChange,
  ...props
}: CheckboxProps) {
  const generatedId = React.useId();
  const itemId = id ?? generatedId;
  const indeterminate = checked === 'indeterminate';
  const onClick = useLabelReentryGuard(props.onClick);

  const labelClassName = cn(
    'flex w-full cursor-pointer items-center gap-3 rounded-md px-3 py-1.5 transition-colors',
    'hover:bg-foreground/3',
    'has-data-[state=checked]:bg-foreground/6 has-data-[state=checked]:hover:bg-foreground/6',
    'has-focus-visible:ring-ring has-focus-visible:ring-offset-background has-focus-visible:ring-2 has-focus-visible:ring-offset-2',
    props.disabled && 'cursor-default opacity-50', // cursor-default: disabled keeps the default cursor (AGENTS.md → States)
    className,
  );

  // With a label, the label wraps only the button. Base UI renders its hidden
  // input next to the root, so it stays outside the label: one control per
  // label, and the input's click does not bubble into the label's activation.
  const render: typeof renderCheckbox = label
    ? (buttonProps, state) => (
        <label className={labelClassName}>
          {renderCheckbox(buttonProps, state)}
          <span
            className={cn(
              'text-sm transition-[color,font-weight]',
              'text-muted-foreground',
              'peer-data-[state=checked]:text-foreground peer-data-[state=checked]:font-medium',
              props.disabled && 'text-muted-foreground',
            )}
          >
            {label}
          </span>
        </label>
      )
    : renderCheckbox;

  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      data-variant={variant}
      id={itemId}
      // The root renders a <button> (`nativeButton`), so button props are right at runtime.
      {...(props as unknown as React.ComponentProps<typeof CheckboxPrimitive.Root>)}
      onClick={onClick}
      checked={checked === undefined ? undefined : checked === true}
      defaultChecked={defaultChecked === undefined ? undefined : defaultChecked === true}
      indeterminate={indeterminate}
      onCheckedChange={(next) => onCheckedChange?.(next)}
      className={cn(
        checkboxControlClassName,
        checkboxVariantClassName[variant],
        !label && className,
      )}
      nativeButton
      render={render}
    />
  );
}

Checkbox.displayName = 'Checkbox';

export { Checkbox };
export type { CheckboxProps, CheckboxVariant, CheckedState };
