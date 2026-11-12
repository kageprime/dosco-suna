'use client';

import * as React from 'react';
import {
  asChildRender,
  composeRefs,
  openState,
  stateRender,
  useNativeButton,
} from '../lib/base-ui-compat';
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
import { MENU_PANEL_STATIC, MENU_SHORTCUT } from './menu-recipe';
import { triggerVariants, type TriggerVariantProps } from './trigger-variants';

/**
 * The row recipe, the panel and the label/separator/shortcut classes live in
 * `./menu-recipe`, shared with `context-menu.tsx` — see that file for why the
 * four row components here (Item, SubTrigger, CheckboxItem, RadioItem) are no
 * longer allowed to style themselves.
 *
 * A dropdown is anchored to a trigger, so its panel is at least as wide as a
 * typical trigger. A right-click menu has no trigger width to match and floors
 * itself lower.
 *
 * No enter/exit animation on the root panel or the submenu. The root panel
 * used to `animate-in` (fade + `zoom-in-95` + a 2-unit slide, ~150ms). The
 * library kept the node mounted until `animate-out` fired `animationend`, so
 * every open AND every close waited on the animation. People
 * open these menus tens of times a day; the project sidebar's workspace
 * switcher is the worst case. The motion read as the menu lagging behind the
 * click, and it dropped frames under load. The panel now paints on the frame it
 * mounts and unmounts on the frame it closes.
 *
 * The submenu lost its animation earlier for a second reason: it opens INTO the
 * pointer's path, so the slide moved its rows away from the cursor.
 */
const DROPDOWN_PANEL = cn(MENU_PANEL_STATIC, 'min-w-[14rem] overflow-hidden');

function DropdownMenu({ onOpenChange, dir: _dir, children, ...props }: MenuRootProps) {
  const root = useMenuRoot(onOpenChange);
  return root.wrap(
    <MenuPrimitive.Root {...props} onOpenChange={root.onOpenChange}>
      {children}
    </MenuPrimitive.Root>,
  );
}

const DropdownMenuTrigger = React.forwardRef<
  HTMLButtonElement,
  Omit<React.ComponentPropsWithoutRef<'button'>, 'size'> &
    TriggerVariantProps & { asChild?: boolean }
>(({ className, variant, size, asChild, children, ...props }, ref) => {
  const slot = asChildRender(asChild, children);
  const native = useNativeButton(asChild, children);
  return (
    <MenuPrimitive.Trigger
      ref={composeRefs(ref, native.ref)}
      {...props}
      // With `asChild` the child owns its styling — merging ours would double it.
      className={asChild ? className : cn(triggerVariants({ variant, size }), className)}
      render={stateRender('button', openState, slot.render)}
      nativeButton={native.nativeButton}
    >
      {slot.children}
    </MenuPrimitive.Trigger>
  );
});
DropdownMenuTrigger.displayName = 'DropdownMenuTrigger';

// No padding of its own: the panel's `p-1` is the only inset, so a grouped
// row is exactly as wide as an ungrouped one.
const DropdownMenuGroup = MenuGroup;

const DropdownMenuPortal = MenuPortalPassthrough;

const DropdownMenuSub = MenuSub;

const DropdownMenuRadioGroup = MenuRadioGroup;

const DropdownMenuSubTrigger = makeMenuSubTrigger();
DropdownMenuSubTrigger.displayName = 'DropdownMenuSubTrigger';

const DropdownMenuSubContent = React.forwardRef<HTMLDivElement, MenuContentProps>(
  // `side` and `align` are accepted and unused: a submenu opens on the inline
  // edge of its trigger. They previously selected a `slide-in-from-*` class;
  // that was the enter animation, which no dropdown panel has any more.
  ({ className, side: _side, align: _align, sideOffset = 5, ...props }, ref) => {
    return (
      <MenuContentImpl
        ref={ref}
        Positioner={MenuPrimitive.Positioner}
        varName="dropdown-menu"
        {...props}
        sideOffset={sideOffset}
        className={cn(DROPDOWN_PANEL, className)}
      />
    );
  },
);
DropdownMenuSubContent.displayName = 'DropdownMenuSubContent';

const DropdownMenuContent = React.forwardRef<HTMLDivElement, MenuContentProps>(
  ({ className, sideOffset = 4, ...props }, ref) => {
    return (
      <MenuContentImpl
        ref={ref}
        Positioner={MenuPrimitive.Positioner}
        varName="dropdown-menu"
        {...props}
        sideOffset={sideOffset}
        className={cn(DROPDOWN_PANEL, className)}
      />
    );
  },
);
DropdownMenuContent.displayName = 'DropdownMenuContent';

const DropdownMenuItem = makeMenuItem();
DropdownMenuItem.displayName = 'DropdownMenuItem';

const DropdownMenuCheckboxItem = makeMenuCheckboxItem();
DropdownMenuCheckboxItem.displayName = 'DropdownMenuCheckboxItem';

const DropdownMenuRadioItem = makeMenuRadioItem();
DropdownMenuRadioItem.displayName = 'DropdownMenuRadioItem';

const DropdownMenuLabel = makeMenuLabel();
DropdownMenuLabel.displayName = 'DropdownMenuLabel';

const DropdownMenuSeparator = makeMenuSeparator();
DropdownMenuSeparator.displayName = 'DropdownMenuSeparator';

const DropdownMenuShortcut = ({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) => {
  return <span className={cn(MENU_SHORTCUT, className)} {...props} />;
};
DropdownMenuShortcut.displayName = 'DropdownMenuShortcut';

export {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuPortal,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
};
