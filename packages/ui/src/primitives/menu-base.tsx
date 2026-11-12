'use client';

/**
 * The Base UI menu parts that `dropdown-menu.tsx` and `context-menu.tsx`
 * share. A context menu's items, groups, submenus and separators are the
 * same Base UI `Menu` parts as a dropdown's; only the root, the trigger and
 * the positioner differ.
 *
 * Every part keeps the Radix contract callers use: `onSelect` with
 * `event.preventDefault()` keeps the menu open, checkbox and radio rows close
 * the menu on select, rows and sub triggers carry `data-state`, and content
 * accepts `onCloseAutoFocus` and the dismiss handlers.
 */

import { Menu as MenuPrimitive } from '@base-ui/react/menu';
import { CheckIcon as Check, CaretRightIcon as ChevronRight } from '@phosphor-icons/react';
import * as React from 'react';

import {
  asChildRender,
  checkedState,
  composeRefs,
  DismissProvider,
  FLOATING_LAYER_ATTR,
  focusProps,
  openState,
  radixPositionVars,
  splitPosition,
  stateRender,
  useDismissContent,
  useDismissRoot,
  type ChangeDetails,
  type DismissHandlers,
  type LegacyPositionProps,
  useNativeButton,
} from '../lib/base-ui-compat';
import { usePortalContainer } from '../lib/portal-container';
import { cn } from '../lib/utils';
import { floatingZ, useDialogDepth } from '../lib/z-stack';
import {
  MENU_INDICATOR,
  MENU_INDICATOR_ICON,
  MENU_INSET,
  MENU_INSET_END,
  MENU_LABEL,
  MENU_SEPARATOR,
  menuRow,
  type MenuRowSize,
} from './menu-recipe';

/* ---------- root: keep-open on a prevented onSelect ---------- */

/**
 * Set by a row whose `onSelect` called `preventDefault()`. The root (and every
 * submenu root) cancels the `item-press` close while it is set. Each row click
 * resets it first, so it never outlives the click that set it.
 */
const KeepOpenContext = React.createContext<React.MutableRefObject<boolean> | null>(null);

export interface MenuRootProps {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  modal?: boolean;
  /** Accepted for Radix parity; Base UI reads the direction from the document. */
  dir?: 'ltr' | 'rtl';
  children?: React.ReactNode;
}

/** Wraps a Base UI menu root's `onOpenChange` with keep-open and dismiss handling. */
export function useMenuRoot(onOpenChange?: (open: boolean) => void) {
  const keepOpen = React.useRef(false);
  const dismiss = useDismissRoot(onOpenChange);
  const handle = React.useCallback(
    (open: boolean, details?: ChangeDetails) => {
      if (!open && details?.reason === 'item-press' && keepOpen.current) {
        details.cancel();
        return;
      }
      dismiss.onOpenChange(open, details);
    },
    [dismiss],
  );
  const wrap = React.useCallback(
    (children: React.ReactNode) => (
      <KeepOpenContext.Provider value={keepOpen}>
        <DismissProvider kind="menu" registry={dismiss.registry}>
          {children}
        </DismissProvider>
      </KeepOpenContext.Provider>
    ),
    [dismiss.registry],
  );
  return { onOpenChange: handle, wrap };
}

/** The Radix `onSelect` event: a cancelable `CustomEvent` dispatched on the row. */
function useSelectHandler(
  onSelect: ((event: Event) => void) | undefined,
  onClick: React.MouseEventHandler<HTMLElement> | undefined,
  disabled: boolean | undefined,
) {
  const keepOpen = React.useContext(KeepOpenContext);
  return (event: React.MouseEvent<HTMLElement>) => {
    if (keepOpen) keepOpen.current = false;
    onClick?.(event);
    if (disabled || !onSelect) return;
    const selectEvent = new CustomEvent('menu.itemSelect', {
      bubbles: true,
      cancelable: true,
      detail: { originalEvent: event.nativeEvent },
    });
    const target = event.currentTarget;
    target.addEventListener('menu.itemSelect', onSelect as EventListener, { once: true });
    target.dispatchEvent(selectEvent);
    if (selectEvent.defaultPrevented && keepOpen) keepOpen.current = true;
  };
}

/* ---------- content ---------- */

export type MenuContentProps = Omit<React.ComponentPropsWithoutRef<'div'>, 'dir'> &
  LegacyPositionProps &
  DismissHandlers & {
    asChild?: boolean;
    forceMount?: true;
    loop?: boolean;
    container?: HTMLElement;
    onCloseAutoFocus?: (event: Event) => void;
    /** Radix menus never moved focus on open; accepted and ignored. */
    onOpenAutoFocus?: (event: Event) => void;
  };

type PositionerComponent = React.ComponentType<
  React.ComponentPropsWithoutRef<typeof MenuPrimitive.Positioner>
>;

/**
 * Portal → Positioner → Popup. `zIndex` sits on the positioner, the fixed
 * element; the popup carries `data-state` and the caller's classes.
 */
export const MenuContentImpl = React.forwardRef<
  HTMLDivElement,
  MenuContentProps & { Positioner: PositionerComponent; varName: string }
>(
  (
    {
      Positioner,
      varName,
      asChild,
      children,
      forceMount,
      loop: _loop,
      container,
      style,
      onCloseAutoFocus,
      onOpenAutoFocus: _onOpenAutoFocus,
      onEscapeKeyDown,
      onPointerDownOutside,
      onFocusOutside,
      onInteractOutside,
      ...rest
    },
    ref,
  ) => {
    const depth = useDialogDepth();
    const scoped = usePortalContainer();
    const popup = React.useRef<HTMLDivElement | null>(null);
    useDismissContent('menu', {
      onEscapeKeyDown,
      onPointerDownOutside,
      onFocusOutside,
      onInteractOutside,
    });
    const { positioner, rest: props } = splitPosition(rest);
    const slot = asChildRender(asChild, children);
    return (
      <MenuPrimitive.Portal container={container ?? scoped} keepMounted={forceMount}>
        <Positioner
          {...positioner}
          {...FLOATING_LAYER_ATTR}
          className="outline-none"
          style={{ zIndex: floatingZ(depth), ...radixPositionVars(varName) }}
        >
          <MenuPrimitive.Popup
            ref={composeRefs(ref, popup)}
            style={style}
            {...props}
            {...focusProps(() => popup.current, undefined, onCloseAutoFocus)}
            render={stateRender('div', openState, slot.render)}
          >
            {slot.children}
          </MenuPrimitive.Popup>
        </Positioner>
      </MenuPrimitive.Portal>
    );
  },
);
MenuContentImpl.displayName = 'MenuContent';

/* ---------- rows ---------- */

type RowBaseProps = Omit<React.ComponentPropsWithoutRef<'div'>, 'onSelect'> & {
  asChild?: boolean;
  disabled?: boolean;
  /** Typeahead text when the children are not plain text. */
  textValue?: string;
  onSelect?: (event: Event) => void;
};

export type MenuItemProps = RowBaseProps & {
  inset?: boolean;
  variant?: 'default' | 'destructive';
  size?: MenuRowSize;
};

export function makeMenuItem(slotName?: string) {
  const Item = React.forwardRef<HTMLDivElement, MenuItemProps>(
    (
      {
        className,
        inset,
        variant = 'default',
        size = 'sm',
        asChild,
        children,
        disabled,
        textValue,
        onSelect,
        onClick,
        ...props
      },
      ref,
    ) => {
      const slot = asChildRender(asChild, children);
      const handleClick = useSelectHandler(onSelect, onClick, disabled);
      // A row is a <div>; with `asChild` it is whatever the child renders.
      const native = useNativeButton(asChild, children);
      return (
        <MenuPrimitive.Item
          ref={composeRefs(ref, native.ref)}
          nativeButton={asChild ? native.nativeButton : false}
          data-slot={slotName}
          className={cn(menuRow(size, variant), inset && MENU_INSET, className)}
          disabled={disabled}
          label={textValue}
          {...props}
          onClick={handleClick}
          render={slot.render}
        >
          {slot.children}
        </MenuPrimitive.Item>
      );
    },
  );
  Item.displayName = 'MenuItem';
  return Item;
}

export type MenuCheckboxItemProps = Omit<RowBaseProps, 'onChange'> & {
  checked?: boolean | 'indeterminate';
  defaultChecked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  reverse?: boolean;
  size?: MenuRowSize;
};

export function makeMenuCheckboxItem(slotName?: string) {
  const CheckboxItem = React.forwardRef<HTMLDivElement, MenuCheckboxItemProps>(
    (
      {
        className,
        children,
        checked,
        defaultChecked,
        onCheckedChange,
        reverse,
        size = 'sm',
        disabled,
        textValue,
        onSelect,
        onClick,
        asChild: _asChild,
        ...props
      },
      ref,
    ) => {
      const handleClick = useSelectHandler(onSelect, onClick, disabled);
      return (
        <MenuPrimitive.CheckboxItem
          ref={ref}
          data-slot={slotName}
          // The check sits in the row's leading slot (absolute, so an unchecked row
          // keeps the same label x as a checked one) and the label starts at
          // `MENU_INSET` — the same x as an `inset` item or an icon row's label.
          className={cn(menuRow(size, 'default'), reverse ? MENU_INSET_END : MENU_INSET, className)}
          checked={checked === undefined ? undefined : checked === true}
          defaultChecked={defaultChecked}
          onCheckedChange={onCheckedChange ? (next) => onCheckedChange(next) : undefined}
          disabled={disabled}
          label={textValue}
          // Radix closes the menu when a checkbox row is picked; Base UI keeps it open.
          closeOnClick
          {...props}
          onClick={handleClick}
          render={stateRender('div', (s: { checked?: boolean }) =>
            checked === 'indeterminate' ? 'indeterminate' : checkedState(s),
          )}
        >
          <span className={cn(MENU_INDICATOR, 'absolute', reverse ? 'right-2' : 'left-2')}>
            <MenuPrimitive.CheckboxItemIndicator>
              <Check className={MENU_INDICATOR_ICON} />
            </MenuPrimitive.CheckboxItemIndicator>
          </span>
          {children}
        </MenuPrimitive.CheckboxItem>
      );
    },
  );
  CheckboxItem.displayName = 'MenuCheckboxItem';
  return CheckboxItem;
}

/**
 * The label column of a radio row. `flex-1` pushes the check to the far
 * edge; `flex` keeps a leading icon on the label's line (Preflight makes
 * `svg` a block). `gap-2` matches `MENU_ROW_BASE`.
 */
const RADIO_LABEL = 'flex min-w-0 flex-1 items-center gap-2';

export type MenuRadioItemProps = RowBaseProps & {
  value: string;
  size?: MenuRowSize;
  side?: 'left' | 'right';
};

export function makeMenuRadioItem(slotName?: string) {
  const RadioItem = React.forwardRef<HTMLDivElement, MenuRadioItemProps>(
    (
      {
        className,
        children,
        size = 'sm',
        side = 'right',
        disabled,
        textValue,
        onSelect,
        onClick,
        asChild: _asChild,
        ...props
      },
      ref,
    ) => {
      const handleClick = useSelectHandler(onSelect, onClick, disabled);
      // A check, not a dot, and the same check the checkbox row uses.
      const indicator = (
        <span className={MENU_INDICATOR}>
          <MenuPrimitive.RadioItemIndicator>
            <Check className={MENU_INDICATOR_ICON} />
          </MenuPrimitive.RadioItemIndicator>
        </span>
      );
      return (
        <MenuPrimitive.RadioItem
          ref={ref}
          data-slot={slotName}
          className={cn(menuRow(size, 'default'), className)}
          disabled={disabled}
          label={textValue}
          // Radix closes the menu when a radio row is picked; Base UI keeps it open.
          closeOnClick
          {...props}
          onClick={handleClick}
          render={stateRender('div', checkedState)}
        >
          {side === 'left' ? (
            <>
              {indicator}
              <span className={RADIO_LABEL}>{children}</span>
            </>
          ) : (
            <>
              <span className={RADIO_LABEL}>{children}</span>
              {indicator}
            </>
          )}
        </MenuPrimitive.RadioItem>
      );
    },
  );
  RadioItem.displayName = 'MenuRadioItem';
  return RadioItem;
}

export interface MenuRadioGroupProps extends Omit<
  React.ComponentPropsWithoutRef<'div'>,
  'defaultValue'
> {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
}

export const MenuRadioGroup = React.forwardRef<HTMLDivElement, MenuRadioGroupProps>(
  ({ onValueChange, ...props }, ref) => (
    <MenuPrimitive.RadioGroup
      ref={ref}
      {...props}
      onValueChange={onValueChange ? (next: unknown) => onValueChange(next as string) : undefined}
    />
  ),
);
MenuRadioGroup.displayName = 'MenuRadioGroup';

/* ---------- group, label, separator ---------- */

const GroupContext = React.createContext(false);

export const MenuGroup = React.forwardRef<HTMLDivElement, React.ComponentPropsWithoutRef<'div'>>(
  (props, ref) => (
    <GroupContext.Provider value={true}>
      <MenuPrimitive.Group ref={ref} {...props} />
    </GroupContext.Provider>
  ),
);
MenuGroup.displayName = 'MenuGroup';

export function makeMenuLabel(slotName?: string) {
  const Label = React.forwardRef<
    HTMLDivElement,
    React.ComponentPropsWithoutRef<'div'> & { inset?: boolean }
  >(({ className, inset, ...props }, ref) => {
    const inGroup = React.useContext(GroupContext);
    const classes = cn(MENU_LABEL, inset && MENU_INSET, className);
    // `GroupLabel` names its group; outside a group the label is plain text, as on Radix.
    return inGroup ? (
      <MenuPrimitive.GroupLabel ref={ref} data-slot={slotName} className={classes} {...props} />
    ) : (
      <div ref={ref} data-slot={slotName} className={classes} {...props} />
    );
  });
  Label.displayName = 'MenuLabel';
  return Label;
}

export function makeMenuSeparator(slotName?: string) {
  const Separator = React.forwardRef<HTMLDivElement, React.ComponentPropsWithoutRef<'div'>>(
    ({ className, ...props }, ref) => (
      <MenuPrimitive.Separator
        ref={ref}
        data-slot={slotName}
        className={cn(MENU_SEPARATOR, className)}
        {...props}
      />
    ),
  );
  Separator.displayName = 'MenuSeparator';
  return Separator;
}

/* ---------- submenu ---------- */

export interface MenuSubProps {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  children?: React.ReactNode;
}

export function MenuSub({ onOpenChange, ...props }: MenuSubProps) {
  const keepOpen = React.useContext(KeepOpenContext);
  return (
    <MenuPrimitive.SubmenuRoot
      {...props}
      onOpenChange={(open, details) => {
        if (!open && details.reason === 'item-press' && keepOpen?.current) {
          details.cancel();
          return;
        }
        onOpenChange?.(open);
      }}
    />
  );
}

export type MenuSubTriggerProps = Omit<React.ComponentPropsWithoutRef<'div'>, 'onSelect'> & {
  inset?: boolean;
  size?: MenuRowSize;
  disabled?: boolean;
  textValue?: string;
};

/**
 * Takes the same `size` and `inset` props as the item, because a submenu
 * trigger is a row like any other and has to line up with its siblings. The
 * caret is `size-3.5` and muted: an affordance, not content.
 */
export function makeMenuSubTrigger(slotName?: string) {
  const SubTrigger = React.forwardRef<HTMLDivElement, MenuSubTriggerProps>(
    ({ className, inset, size = 'sm', children, textValue, ...props }, ref) => (
      <MenuPrimitive.SubmenuTrigger
        ref={ref}
        data-slot={slotName}
        className={cn('group', menuRow(size, 'default'), inset && MENU_INSET, className)}
        label={textValue}
        {...props}
        render={stateRender('div', openState)}
      >
        {children}
        <ChevronRight className="text-muted-foreground ml-auto size-3.5" />
      </MenuPrimitive.SubmenuTrigger>
    ),
  );
  SubTrigger.displayName = 'MenuSubTrigger';
  return SubTrigger;
}

/** A passthrough: every content part already portals itself. */
export function MenuPortalPassthrough({
  children,
}: {
  children?: React.ReactNode;
  container?: HTMLElement;
  forceMount?: true;
}) {
  return <>{children}</>;
}

export { MenuPrimitive };
