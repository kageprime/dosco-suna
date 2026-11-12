'use client';

import { ContextMenu as ContextMenuPrimitive } from '@base-ui/react/context-menu';
import * as React from 'react';

import { asChildRender, openState, stateRender } from '../lib/base-ui-compat';
import { cn } from '../lib/utils';
import {
  makeMenuCheckboxItem,
  makeMenuItem,
  makeMenuLabel,
  makeMenuRadioItem,
  makeMenuSeparator,
  makeMenuSubTrigger,
  MenuContentImpl,
  MenuGroup,
  MenuPortalPassthrough,
  MenuPrimitive,
  MenuRadioGroup,
  MenuSub,
  useMenuRoot,
  type MenuContentProps,
  type MenuRootProps,
} from './menu-base';
import { MENU_PANEL, MENU_SHORTCUT } from './menu-recipe';

/**
 * A right-click menu is the same menu as a click menu. It shares the row
 * recipe, panel, label, separator and shortcut in `./menu-recipe` with
 * `dropdown-menu.tsx`, so a `Rename` row looks identical whichever way the
 * user reached it. Before this, the two menus disagreed on radius (sm vs md),
 * horizontal padding (2 vs 2.5), highlight colour (`accent` vs `primary/10`)
 * and resting text colour — and the file browser shows both.
 *
 * Three things stay local, because they are genuinely different:
 *
 * 1. **Width floor** — a dropdown matches its trigger, so it floors at 14rem.
 *    A context menu opens at the pointer with nothing to match, and every call
 *    site here passes its own width (`w-40`, `w-48`, `w-64`). A 14rem floor
 *    would override `w-40`, so this menu floors at 8rem.
 *
 * 2. **Transform origin** — the panel scales out of the point that was
 *    right-clicked (`--radix-context-menu-content-transform-origin`) rather
 *    than its own centre. The menu appearing to grow from the cursor is the
 *    whole spatial story of a context menu.
 *
 * 3. **Scroll** — `Content` caps at the available viewport height and scrolls,
 *    while `SubContent` clips like a dropdown. A context menu opened near the
 *    bottom edge of the window has no room to grow downward; clipping it would
 *    hide the last rows with no way to reach them.
 *
 * No trigger styling. `DropdownMenuTrigger` applies `triggerVariants` because
 * a dropdown trigger is a button; a context-menu trigger is the region you
 * right-click and must stay visually untouched.
 */
const CONTEXT_PANEL = cn(
  MENU_PANEL,
  'min-w-[8rem] origin-(--radix-context-menu-content-transform-origin)',
);

function ContextMenu({
  onOpenChange,
  dir: _dir,
  children,
  ...props
}: Omit<MenuRootProps, 'open' | 'defaultOpen'> & { open?: boolean; defaultOpen?: boolean }) {
  const root = useMenuRoot(onOpenChange);
  return root.wrap(
    <ContextMenuPrimitive.Root {...props} onOpenChange={root.onOpenChange}>
      {children}
    </ContextMenuPrimitive.Root>,
  );
}

/** The right-click area. A `<span>` unless `asChild`, as on Radix. */
const ContextMenuTrigger = React.forwardRef<
  HTMLSpanElement,
  React.ComponentPropsWithoutRef<'span'> & { asChild?: boolean; disabled?: boolean }
>(({ asChild, children, disabled: _disabled, ...props }, ref) => {
  const slot = asChildRender(asChild, children);
  return (
    <ContextMenuPrimitive.Trigger
      ref={ref as React.Ref<HTMLDivElement>}
      {...props}
      render={stateRender('span', openState, slot.render)}
    >
      {slot.children}
    </ContextMenuPrimitive.Trigger>
  );
});
ContextMenuTrigger.displayName = 'ContextMenuTrigger';

const ContextMenuPortal = MenuPortalPassthrough;

const ContextMenuSub = MenuSub;

const ContextMenuRadioGroup = MenuRadioGroup;

const ContextMenuGroup = MenuGroup;

const ContextMenuSubTrigger = makeMenuSubTrigger('context-menu-sub-trigger');
ContextMenuSubTrigger.displayName = 'ContextMenuSubTrigger';

// `sideOffset={4}` matches the dropdown: 4px of daylight keeps the two panels
// legible as parent and child, and the safe-polygon pointer tracking covers
// the gap, so the submenu does not close while the cursor crosses it.
const ContextMenuSubContent = React.forwardRef<HTMLDivElement, MenuContentProps>(
  ({ className, sideOffset = 4, ...props }, ref) => {
    return (
      <MenuContentImpl
        ref={ref}
        Positioner={MenuPrimitive.Positioner}
        varName="context-menu"
        {...props}
        sideOffset={sideOffset}
        data-slot="context-menu-sub-content"
        className={cn(CONTEXT_PANEL, 'overflow-hidden', className)}
      />
    );
  },
);
ContextMenuSubContent.displayName = 'ContextMenuSubContent';

const ContextMenuContent = React.forwardRef<HTMLDivElement, MenuContentProps>(
  ({ className, ...props }, ref) => {
    return (
      <MenuContentImpl
        ref={ref}
        Positioner={ContextMenuPrimitive.Positioner}
        varName="context-menu"
        {...props}
        data-slot="context-menu-content"
        className={cn(
          CONTEXT_PANEL,
          'max-h-(--radix-context-menu-content-available-height) overflow-x-hidden overflow-y-auto',
          className,
        )}
      />
    );
  },
);
ContextMenuContent.displayName = 'ContextMenuContent';

const ContextMenuItem = makeMenuItem('context-menu-item');
ContextMenuItem.displayName = 'ContextMenuItem';

// Same geometry as `DropdownMenuCheckboxItem` — see there.
const ContextMenuCheckboxItem = makeMenuCheckboxItem('context-menu-checkbox-item');
ContextMenuCheckboxItem.displayName = 'ContextMenuCheckboxItem';

const ContextMenuRadioItem = makeMenuRadioItem('context-menu-radio-item');
ContextMenuRadioItem.displayName = 'ContextMenuRadioItem';

const ContextMenuLabel = makeMenuLabel('context-menu-label');
ContextMenuLabel.displayName = 'ContextMenuLabel';

const ContextMenuSeparator = makeMenuSeparator('context-menu-separator');
ContextMenuSeparator.displayName = 'ContextMenuSeparator';

const ContextMenuShortcut = ({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) => {
  return (
    <span data-slot="context-menu-shortcut" className={cn(MENU_SHORTCUT, className)} {...props} />
  );
};
ContextMenuShortcut.displayName = 'ContextMenuShortcut';

export {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuPortal,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
};
