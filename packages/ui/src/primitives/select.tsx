'use client';

import { Select as SelectPrimitive } from '@base-ui/react/select';
import {
  CheckIcon as Check,
  CaretDownIcon as ChevronDown,
  CaretUpIcon as ChevronUp,
} from '@phosphor-icons/react';
import * as React from 'react';

import {
  checkedState,
  FLOATING_LAYER_ATTR,
  openState,
  radixPositionVars,
  splitPosition,
  stateRender,
  type LegacyPositionProps,
} from '../lib/base-ui-compat';
import { withPortalContainer } from '../lib/portal-container';
import { cn } from '../lib/utils';
import { floatingZ, useDialogDepth } from '../lib/z-stack';
import {
  MENU_INDICATOR,
  MENU_INDICATOR_ICON,
  MENU_INSET_END,
  MENU_LABEL,
  MENU_PANEL_STATIC,
  MENU_SEPARATOR,
  menuRow,
  type MenuRowSize,
} from './menu-recipe';
import {
  TRIGGER_CARET_CLASS,
  TRIGGER_ICON_SIZE,
  triggerVariants,
  type TriggerVariantProps,
} from './trigger-variants';

const SelectPortal = withPortalContainer(SelectPrimitive.Portal);

/**
 * A select is a menu: the same floating surface holding the same rows, and it
 * shares both with the dropdown and context menu through `./menu-recipe`.
 *
 * Local to a select: `max-h-96` plus the scroll arrows, because the option
 * list is data-length and a dropdown's is authored; and `min-w-56`, because a
 * select is anchored to a trigger it should not visibly undercut.
 *
 * No enter/exit animation, the same as `DropdownMenuContent`: the list paints
 * on the frame it mounts and unmounts on the frame it closes. See
 * `dropdown-menu.tsx` for why.
 */
const SELECT_PANEL = cn(MENU_PANEL_STATIC, 'min-w-56 overflow-hidden');

/* ---------- item labels for the trigger ---------- */

/**
 * Base UI's `Select.Value` renders the raw value unless the root knows each
 * item's label. Radix rendered the selected item's text. The root collects
 * labels two ways: from the `SelectItem` elements in its JSX tree (so the
 * label shows before the list was ever opened), and from each mounted
 * `SelectItem` (for items a custom component renders).
 */
type LabelMap = Record<string, React.ReactNode>;

const SelectLabelsContext = React.createContext<
  ((value: string, label: React.ReactNode) => void) | null
>(null);

function collectLabels(node: React.ReactNode, out: LabelMap) {
  React.Children.forEach(node, (child) => {
    if (!React.isValidElement(child)) return;
    const props = child.props as { value?: unknown; children?: React.ReactNode };
    if (child.type === SelectItem && props.value != null) {
      out[String(props.value)] = props.children;
      return;
    }
    if (props.children) collectLabels(props.children, out);
  });
}

/** Radix treats `''` and `undefined` as "no value"; Base UI uses `null`. */
const toBaseValue = (value: string | undefined) =>
  value === undefined || value === '' ? null : value;

export interface SelectProps {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  disabled?: boolean;
  required?: boolean;
  name?: string;
  form?: string;
  autoComplete?: string;
  modal?: boolean;
  /** Accepted for Radix parity; Base UI reads the direction from the document. */
  dir?: 'ltr' | 'rtl';
  children?: React.ReactNode;
}

function Select(allProps: SelectProps) {
  const {
    value,
    defaultValue,
    onValueChange,
    open,
    defaultOpen,
    onOpenChange,
    dir: _dir,
    children,
    ...props
  } = allProps;
  const [mounted, setMounted] = React.useState<LabelMap>({});
  const register = React.useCallback((key: string, label: React.ReactNode) => {
    setMounted((prev) => (prev[key] === label ? prev : { ...prev, [key]: label }));
  }, []);
  const items = React.useMemo(() => {
    const fromTree: LabelMap = {};
    collectLabels(children, fromTree);
    return { ...mounted, ...fromTree };
  }, [children, mounted]);
  // A `value` key, even `value={undefined}`, means a controlled select that
  // shows its placeholder; no key means uncontrolled.
  const controlled = 'value' in allProps;

  return (
    <SelectLabelsContext.Provider value={register}>
      <SelectPrimitive.Root<string>
        {...props}
        items={items}
        {...(controlled
          ? { value: toBaseValue(value) }
          : { defaultValue: toBaseValue(defaultValue) })}
        onValueChange={(next) => {
          if (typeof next === 'string') onValueChange?.(next);
        }}
        open={open}
        defaultOpen={defaultOpen}
        onOpenChange={onOpenChange ? (next) => onOpenChange(next) : undefined}
      >
        {children}
      </SelectPrimitive.Root>
    </SelectLabelsContext.Provider>
  );
}

/* ---------- group and label ---------- */

const SelectGroupContext = React.createContext(false);

const SelectGroup = React.forwardRef<HTMLDivElement, React.ComponentPropsWithoutRef<'div'>>(
  (props, ref) => (
    <SelectGroupContext.Provider value={true}>
      <SelectPrimitive.Group ref={ref} {...props} />
    </SelectGroupContext.Provider>
  ),
);
SelectGroup.displayName = 'SelectGroup';

const SelectLabel = React.forwardRef<HTMLDivElement, React.ComponentPropsWithoutRef<'div'>>(
  ({ className, ...props }, ref) => {
    const inGroup = React.useContext(SelectGroupContext);
    // Was `pl-8 text-sm font-semibold` — the `pl-8` reserved a left gutter for a
    // leading check that this select does not have (its indicator is at
    // `right-3`), so the label sat indented past every option under it.
    const classes = cn(MENU_LABEL, className);
    // `GroupLabel` labels its group; outside a group the label is plain text.
    return inGroup ? (
      <SelectPrimitive.GroupLabel ref={ref} className={classes} {...props} />
    ) : (
      <div ref={ref} className={classes} {...props} />
    );
  },
);
SelectLabel.displayName = 'SelectLabel';

/* ---------- trigger and value ---------- */

const SelectValue = React.forwardRef<
  HTMLSpanElement,
  Omit<React.ComponentPropsWithoutRef<'span'>, 'children'> & {
    placeholder?: React.ReactNode;
    children?: React.ReactNode;
  }
>(({ children, ...props }, ref) => (
  <SelectPrimitive.Value ref={ref} {...props}>
    {children ?? undefined}
  </SelectPrimitive.Value>
));
SelectValue.displayName = 'SelectValue';

export type SelectTriggerProps = Omit<React.ComponentPropsWithoutRef<'button'>, 'size' | 'value'> &
  TriggerVariantProps & {
    arrow?: boolean;
  };

const SelectTrigger = React.forwardRef<HTMLButtonElement, SelectTriggerProps>(
  ({ className, children, variant, size, arrow = true, ...props }, ref) => (
    <SelectPrimitive.Trigger
      ref={ref}
      className={cn(triggerVariants({ variant, size }), className)}
      {...props}
      render={stateRender('button', openState)}
    >
      {children}
      {arrow && (
        // Children, not `render`: without children Base UI fills the icon with a `▼` glyph.
        <SelectPrimitive.Icon className="flex shrink-0">
          <ChevronDown className={cn(TRIGGER_CARET_CLASS, TRIGGER_ICON_SIZE[size ?? 'sm'])} />
        </SelectPrimitive.Icon>
      )}
    </SelectPrimitive.Trigger>
  ),
);
SelectTrigger.displayName = 'SelectTrigger';

/* ---------- content ---------- */

const SelectScrollUpButton = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<'div'>
>(({ className, ...props }, ref) => (
  <SelectPrimitive.ScrollUpArrow
    ref={ref}
    className={cn(
      'bg-popover absolute inset-x-0 top-0 z-[1] flex cursor-default items-center justify-center py-1', // cursor-default: hover-scroll area, not a control.
      className,
    )}
    {...props}
  >
    <ChevronUp className="size-4" />
  </SelectPrimitive.ScrollUpArrow>
));
SelectScrollUpButton.displayName = 'SelectScrollUpButton';

const SelectScrollDownButton = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<'div'>
>(({ className, ...props }, ref) => (
  <SelectPrimitive.ScrollDownArrow
    ref={ref}
    className={cn(
      'bg-popover absolute inset-x-0 bottom-0 z-[1] flex cursor-default items-center justify-center py-1', // cursor-default: hover-scroll area, not a control.
      className,
    )}
    {...props}
  >
    <ChevronDown className="size-4" />
  </SelectPrimitive.ScrollDownArrow>
));
SelectScrollDownButton.displayName = 'SelectScrollDownButton';

export type SelectContentProps = React.ComponentPropsWithoutRef<'div'> &
  LegacyPositionProps & {
    /** Radix positioning mode. `item-aligned` overlaps the trigger like a native select. */
    position?: 'popper' | 'item-aligned';
    /** The Base UI name for `position="item-aligned"`. Wins over `position`. */
    alignItemWithTrigger?: boolean;
    container?: HTMLElement;
    onCloseAutoFocus?: (event: Event) => void;
    onEscapeKeyDown?: (event: KeyboardEvent) => void;
    onPointerDownOutside?: (event: Event) => void;
  };

const SelectContent = React.forwardRef<HTMLDivElement, SelectContentProps>(
  (
    {
      className,
      children,
      position = 'popper',
      alignItemWithTrigger,
      container,
      style,
      onCloseAutoFocus: _onCloseAutoFocus,
      onEscapeKeyDown: _onEscapeKeyDown,
      onPointerDownOutside: _onPointerDownOutside,
      ...rest
    },
    ref,
  ) => {
    const depth = useDialogDepth();
    const { positioner, rest: props } = splitPosition(rest);
    const aligned = alignItemWithTrigger ?? position === 'item-aligned';

    return (
      <SelectPortal container={container}>
        <SelectPrimitive.Positioner
          {...positioner}
          {...FLOATING_LAYER_ATTR}
          alignItemWithTrigger={aligned}
          className="outline-none"
          style={{ zIndex: floatingZ(depth), ...radixPositionVars('select') }}
        >
          <SelectPrimitive.Popup
            ref={ref}
            className={cn(
              SELECT_PANEL,
              !aligned &&
                'data-[side=bottom]:translate-y-1 data-[side=left]:-translate-x-1 data-[side=right]:translate-x-1 data-[side=top]:-translate-y-1',
              className,
            )}
            style={style}
            {...props}
            render={stateRender('div', openState)}
          >
            <SelectScrollUpButton />
            <SelectPrimitive.List
              className={cn(
                'max-h-[min(24rem,var(--available-height))] scroll-py-6 overflow-y-auto',
                !aligned && 'w-full min-w-[calc(var(--anchor-width)-8px)]',
              )}
            >
              {children}
            </SelectPrimitive.List>
            <SelectScrollDownButton />
          </SelectPrimitive.Popup>
        </SelectPrimitive.Positioner>
      </SelectPortal>
    );
  },
);
SelectContent.displayName = 'SelectContent';

/* ---------- item ---------- */

const SelectItem = React.forwardRef<
  HTMLDivElement,
  Omit<React.ComponentPropsWithoutRef<'div'>, 'value'> & {
    value: string;
    disabled?: boolean;
    /** Typeahead text when the children are not plain text. */
    textValue?: string;
    /** Row height step — see `MENU_ROW_SIZE` in `./menu-recipe`. */
    size?: MenuRowSize;
    /** Renders below children in the dropdown only — not in the trigger. */
    description?: React.ReactNode;
  }
>(({ className, children, size = 'sm', description, value, textValue, ...props }, ref) => {
  const register = React.useContext(SelectLabelsContext);
  React.useEffect(() => {
    register?.(value, children);
  }, [register, value, children]);

  return (
    <SelectPrimitive.Item
      ref={ref}
      value={value}
      label={textValue}
      // `MENU_INSET_END` reserves the trailing slot on every row, checked or
      // not, so a long label truncates before the check instead of running
      // under it, and the check column is the same x on every row.
      className={cn(
        menuRow(size, 'default'),
        MENU_INSET_END,
        description && 'items-start',
        className,
      )}
      {...props}
      render={stateRender('div', (s: { selected?: boolean }) =>
        checkedState({ checked: s.selected }),
      )}
    >
      <span
        data-slot="select-item-indicator"
        // Absolute inside a flex row: its static position follows the row's
        // `items-*`, so it centres on a one-line row. On a described row it tops
        // out, and `mt-0.5` centres the ~15px slot on the 20px first line.
        className={cn(MENU_INDICATOR, 'absolute right-2', description && 'mt-0.5')}
      >
        <SelectPrimitive.ItemIndicator>
          <Check className={MENU_INDICATOR_ICON} />
        </SelectPrimitive.ItemIndicator>
      </span>

      {description ? (
        <div className="flex min-w-0 flex-col gap-0.5">
          <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
          <span className="text-muted-foreground max-w-64 text-xs whitespace-normal">
            {description}
          </span>
        </div>
      ) : (
        <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
      )}
    </SelectPrimitive.Item>
  );
});
SelectItem.displayName = 'SelectItem';

const SelectSeparator = React.forwardRef<HTMLDivElement, React.ComponentPropsWithoutRef<'div'>>(
  ({ className, ...props }, ref) => (
    <SelectPrimitive.Separator ref={ref} className={cn(MENU_SEPARATOR, className)} {...props} />
  ),
);
SelectSeparator.displayName = 'SelectSeparator';

export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectScrollDownButton,
  SelectScrollUpButton,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
};
