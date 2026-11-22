'use client';

import { MagnifyingGlassIcon } from '@phosphor-icons/react';
import { useRef, useState, type ComponentProps } from 'react';

import { cn } from '../lib/utils';
import { Button } from './button';
import type { InputProps } from './input';
import { InputGroupSearch, InputGroupSearchClear, InputGroupSearchIcon, InputGroupSearchInput } from './input-group';

type ButtonSize = NonNullable<ComponentProps<typeof Button>['size']>;
type ButtonVariant = NonNullable<ComponentProps<typeof Button>['variant']>;
type InputSize = NonNullable<InputProps['size']>;

/**
 * Each preset pairs an icon button and an input of the SAME height, so opening
 * the search never moves the row: `sm` 32px-ish (`size-8` / `h-8`), `md`
 * (`size-9` / `h-9`), `lg` (`size-10` / `h-10`).
 */
const SIZES = {
  sm: { button: 'icon-base', input: 'xs' },
  md: { button: 'icon-md', input: 'sm' },
  lg: { button: 'icon-lg', input: 'md' },
} as const satisfies Record<string, { button: ButtonSize; input: InputSize }>;

export type ExpandableSearchSize = keyof typeof SIZES;

/**
 * A search that takes no room until it is needed: a magnifier icon button
 * that opens into a search input in the same place.
 *
 * - Click (or Enter/Space) opens it and focuses the input.
 * - Escape clears the query, closes it, and gives focus back to the button.
 * - Leaving it empty (blur) closes it; with a query it stays open, so the
 *   filter it applies is always visible.
 *
 * Controlled: the host owns `value`. `size` picks a matched button/input pair;
 * `buttonSize` and `inputSize` override either half for a host whose row has
 * its own rhythm.
 */
export function ExpandableSearch({
  value,
  onValueChange,
  label,
  placeholder,
  size = 'sm',
  buttonSize,
  buttonVariant = 'ghost',
  inputSize,
  defaultOpen = false,
  className,
  inputClassName,
}: {
  value: string;
  onValueChange: (value: string) => void;
  /** The button's and the input's accessible name, e.g. "Search sessions". */
  label: string;
  /** Defaults to `label`. */
  placeholder?: string;
  size?: ExpandableSearchSize;
  buttonSize?: ButtonSize;
  /** The closed icon button's look; `ghost` by default. */
  buttonVariant?: ButtonVariant;
  inputSize?: InputSize;
  defaultOpen?: boolean;
  /** The open input's wrapper: set its width here (default `w-56`). */
  className?: string;
  inputClassName?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const preset = SIZES[size];
  const expanded = open || value.length > 0;

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) requestAnimationFrame(() => buttonRef.current?.focus());
  };

  if (!expanded) {
    return (
      <Button
        ref={buttonRef}
        type="button"
        variant={buttonVariant}
        size={buttonSize ?? preset.button}
        aria-label={label}
        title={label}
        onClick={() => setOpen(true)}
        className="text-muted-foreground hover:text-foreground shrink-0"
      >
        <MagnifyingGlassIcon className="size-4" />
      </Button>
    );
  }

  return (
    <InputGroupSearch className={cn('w-56', className)}>
      <InputGroupSearchIcon>
        <MagnifyingGlassIcon />
      </InputGroupSearchIcon>
      <InputGroupSearchInput
        type="text"
        autoFocus
        autoComplete="off"
        size={inputSize ?? preset.input}
        placeholder={placeholder ?? label}
        aria-label={label}
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
        onBlur={() => {
          if (!value) close(false);
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return;
          event.preventDefault();
          onValueChange('');
          close(true);
        }}
        className={inputClassName}
      />
      <InputGroupSearchClear
        // Keep focus in the input: a mousedown on the button would blur it first and close an empty search.
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => onValueChange('')}
      />
    </InputGroupSearch>
  );
}
