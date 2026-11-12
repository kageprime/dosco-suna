'use client';

import { NavigationMenu as NavigationMenuPrimitive } from '@base-ui/react/navigation-menu';
import { CaretDownIcon as ChevronDownIcon } from '@phosphor-icons/react';
import { cva } from 'class-variance-authority';
import * as React from 'react';

import { asChildRender, FLOATING_LAYER_ATTR, openState, stateRender } from '../lib/base-ui-compat';
import { usePortalContainer } from '../lib/portal-container';
import { cn } from '../lib/utils';

/**
 * Base UI always renders the open item's content in one popup viewport, so
 * `viewport={false}` (inline content under each trigger) is accepted and
 * renders the same shared viewport.
 */
function NavigationMenu({
  className,
  children,
  viewport = true,
  value,
  defaultValue,
  onValueChange,
  delayDuration,
  ...props
}: Omit<React.ComponentPropsWithoutRef<'nav'>, 'defaultValue' | 'dir'> & {
  viewport?: boolean;
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  /** Radix name for the open delay. */
  delayDuration?: number;
  orientation?: 'horizontal' | 'vertical';
  dir?: 'ltr' | 'rtl';
}) {
  const { dir: _dir, ...rest } = props;
  return (
    <NavigationMenuPrimitive.Root
      data-slot="navigation-menu"
      data-viewport={viewport}
      className={cn(
        'group/navigation-menu relative flex max-w-max flex-1 items-center justify-center',
        className,
      )}
      {...(value !== undefined ? { value: value || null } : {})}
      defaultValue={defaultValue ?? null}
      onValueChange={
        onValueChange ? (next) => onValueChange((next as string | null) ?? '') : undefined
      }
      delay={delayDuration}
      {...rest}
    >
      {children}
      <NavigationMenuViewport />
    </NavigationMenuPrimitive.Root>
  );
}

function NavigationMenuList({ className, ...props }: React.ComponentPropsWithoutRef<'ul'>) {
  return (
    <NavigationMenuPrimitive.List
      data-slot="navigation-menu-list"
      className={cn('group flex flex-1 list-none items-center justify-center gap-1', className)}
      {...props}
    />
  );
}

function NavigationMenuItem({
  className,
  ...props
}: React.ComponentPropsWithoutRef<'li'> & { value?: string }) {
  return (
    <NavigationMenuPrimitive.Item
      data-slot="navigation-menu-item"
      className={cn('relative', className)}
      {...props}
    />
  );
}

const navigationMenuTriggerStyle = cva(
  'group inline-flex h-9 w-max items-center justify-center rounded-md bg-background px-4 py-2 text-sm font-medium transition-[color,box-shadow] outline-none hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1 disabled:pointer-events-none disabled:opacity-50 data-[state=open]:bg-accent/50 data-[state=open]:text-accent-foreground data-[state=open]:hover:bg-accent data-[state=open]:focus:bg-accent',
);

function NavigationMenuTrigger({
  className,
  children,
  ...props
}: React.ComponentPropsWithoutRef<'button'>) {
  return (
    <NavigationMenuPrimitive.Trigger
      data-slot="navigation-menu-trigger"
      className={cn(navigationMenuTriggerStyle(), 'group', className)}
      {...props}
      render={stateRender('button', openState)}
    >
      {children}{' '}
      <ChevronDownIcon
        className="duration-slow relative top-[1px] ml-1 size-3 transition group-data-[state=open]:rotate-180"
        aria-hidden="true"
      />
    </NavigationMenuPrimitive.Trigger>
  );
}

function NavigationMenuContent({
  className,
  children,
  ...props
}: React.ComponentPropsWithoutRef<'div'> & { forceMount?: true }) {
  const { forceMount: _forceMount, ...rest } = props;
  return (
    <NavigationMenuPrimitive.Content
      data-slot="navigation-menu-content"
      className={cn(
        'data-[motion=from-end]:slide-in-from-right-52 data-[motion=from-start]:slide-in-from-left-52 data-[motion=to-end]:slide-out-to-right-52 data-[motion=to-start]:slide-out-to-left-52 data-[motion^=from-]:animate-in data-[motion^=from-]:fade-in data-[motion^=to-]:animate-out data-[motion^=to-]:fade-out top-0 left-0 w-full p-1 md:absolute md:w-auto',
        'group-data-[viewport=false]/navigation-menu:bg-background group-data-[viewport=false]/navigation-menu:text-popover-foreground group-data-[viewport=false]/navigation-menu:data-[state=closed]:animate-out group-data-[viewport=false]/navigation-menu:data-[state=closed]:fade-out-0 group-data-[viewport=false]/navigation-menu:data-[state=closed]:zoom-out-95 group-data-[viewport=false]/navigation-menu:data-[state=open]:animate-in group-data-[viewport=false]/navigation-menu:data-[state=open]:fade-in-0 group-data-[viewport=false]/navigation-menu:data-[state=open]:zoom-in-95 group-data-[viewport=false]/navigation-menu:duration-moderate group-data-[viewport=false]/navigation-menu:top-full group-data-[viewport=false]/navigation-menu:mt-1.5 group-data-[viewport=false]/navigation-menu:overflow-hidden group-data-[viewport=false]/navigation-menu:rounded-md group-data-[viewport=false]/navigation-menu:border group-data-[viewport=false]/navigation-menu:shadow-xs **:data-[slot=navigation-menu-link]:focus:ring-0 **:data-[slot=navigation-menu-link]:focus:outline-none',
        className,
      )}
      {...rest}
      render={stateRender('div', openState)}
    >
      <div className="bg-muted dark:bg-popover/50 rounded-sm p-0.5">{children}</div>
    </NavigationMenuPrimitive.Content>
  );
}

/**
 * Portal → Positioner → Popup → Viewport. The popup keeps the Radix
 * `--radix-navigation-menu-viewport-*` names for its size.
 */
function NavigationMenuViewport({ className, ...props }: React.ComponentPropsWithoutRef<'div'>) {
  const scoped = usePortalContainer();
  return (
    <NavigationMenuPrimitive.Portal container={scoped}>
      <NavigationMenuPrimitive.Positioner
        {...FLOATING_LAYER_ATTR}
        className="isolate z-50"
        sideOffset={0}
      >
        <NavigationMenuPrimitive.Popup
          data-slot="navigation-menu-viewport"
          className={cn(
            'origin-top-center bg-popover text-popover-foreground data-[state=closed]:animate-out data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:zoom-in-90 relative mt-1.5 h-[var(--radix-navigation-menu-viewport-height)] w-full overflow-hidden rounded-md border shadow md:w-[var(--radix-navigation-menu-viewport-width)]',
            className,
          )}
          style={
            {
              '--radix-navigation-menu-viewport-height': 'var(--popup-height)',
              '--radix-navigation-menu-viewport-width': 'var(--popup-width)',
            } as React.CSSProperties
          }
          {...(props as object)}
          render={stateRender('div', openState)}
        >
          <NavigationMenuPrimitive.Viewport className="relative h-full w-full overflow-hidden" />
        </NavigationMenuPrimitive.Popup>
      </NavigationMenuPrimitive.Positioner>
    </NavigationMenuPrimitive.Portal>
  );
}

function NavigationMenuLink({
  className,
  asChild,
  children,
  active,
  ...props
}: React.ComponentPropsWithoutRef<'a'> & { asChild?: boolean; active?: boolean }) {
  const slot = asChildRender(asChild, children);
  return (
    <NavigationMenuPrimitive.Link
      data-slot="navigation-menu-link"
      data-active={active ? 'true' : undefined}
      active={active}
      className={cn(
        "hover:bg-popover dark:hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground focus-visible:ring-ring/50 data-[active=true]:bg-accent/50 data-[active=true]:text-accent-foreground data-[active=true]:hover:bg-accent data-[active=true]:focus:bg-accent [&_svg:not([class*='text-'])]:text-muted-foreground flex flex-col gap-1 rounded-sm p-2 text-sm transition-all outline-none focus-visible:ring-[3px] focus-visible:outline-1 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
      render={slot.render}
    >
      {slot.children}
    </NavigationMenuPrimitive.Link>
  );
}

function NavigationMenuSeparator({
  className,
  orientation = 'horizontal',
  decorative = true,
  ...props
}: React.ComponentPropsWithoutRef<'div'> & {
  orientation?: 'horizontal' | 'vertical';
  decorative?: boolean;
}) {
  return (
    <div
      data-slot="navigation-menu-separator"
      data-orientation={orientation}
      {...(decorative ? { role: 'none' } : { role: 'separator', 'aria-orientation': orientation })}
      className={cn(
        'bg-border shrink-0 data-[orientation=horizontal]:h-px data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-auto data-[orientation=vertical]:w-px data-[orientation=vertical]:self-stretch',
        className,
      )}
      {...props}
    />
  );
}

/** The arrow that points at the open trigger. Renders inside the popup. */
function NavigationMenuIndicator({ className, ...props }: React.ComponentPropsWithoutRef<'div'>) {
  return (
    <NavigationMenuPrimitive.Arrow
      data-slot="navigation-menu-indicator"
      className={cn(
        'data-[state=hidden]:animate-out data-[state=hidden]:fade-out data-[state=visible]:animate-in data-[state=visible]:fade-in top-full z-[1] flex h-1.5 items-end justify-center overflow-hidden',
        className,
      )}
      {...props}
      render={stateRender('div', (s: { open?: boolean }) => (s.open ? 'visible' : 'hidden'))}
    >
      <div className="bg-border relative top-[60%] h-2 w-2 rotate-45 rounded-tl-sm shadow" />
    </NavigationMenuPrimitive.Arrow>
  );
}

export {
  NavigationMenu,
  NavigationMenuContent,
  NavigationMenuIndicator,
  NavigationMenuItem,
  NavigationMenuLink,
  NavigationMenuList,
  NavigationMenuSeparator,
  NavigationMenuTrigger,
  navigationMenuTriggerStyle,
  NavigationMenuViewport,
};
