import * as React from "react"
import { NavigationMenu as NavigationMenuPrimitive } from "@base-ui/react/navigation-menu"
import { cva } from "class-variance-authority"
import { ChevronDown } from "lucide-react"

import { cn } from "@/lib/utils"

function NavigationMenu({
  className,
  children,
  ...props
}: NavigationMenuPrimitive.Root.Props) {
  return (
    <NavigationMenuPrimitive.Root
      data-slot="navigation-menu"
      className={cn(
        "relative z-10 flex max-w-max flex-1 items-center justify-center",
        className
      )}
      {...props}
    >
      {children}
      <NavigationMenuViewport />
    </NavigationMenuPrimitive.Root>
  )
}

function NavigationMenuList({
  className,
  ...props
}: NavigationMenuPrimitive.List.Props) {
  return (
    <NavigationMenuPrimitive.List
      data-slot="navigation-menu-list"
      className={cn(
        "group flex flex-1 list-none items-center justify-center space-x-1",
        className
      )}
      {...props}
    />
  )
}

function NavigationMenuItem(props: NavigationMenuPrimitive.Item.Props) {
  return (
    <NavigationMenuPrimitive.Item data-slot="navigation-menu-item" {...props} />
  )
}

const navigationMenuTriggerStyle = cva(
  "group inline-flex h-10 w-max items-center justify-center rounded-md bg-background px-4 py-2 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground focus:outline-none disabled:pointer-events-none disabled:opacity-50 data-[popup-open]:text-accent-foreground data-[popup-open]:bg-accent/50 data-[popup-open]:hover:bg-accent data-[popup-open]:focus:bg-accent"
)

function NavigationMenuTrigger({
  className,
  children,
  ...props
}: NavigationMenuPrimitive.Trigger.Props) {
  return (
    <NavigationMenuPrimitive.Trigger
      data-slot="navigation-menu-trigger"
      className={cn(navigationMenuTriggerStyle(), "group", className)}
      {...props}
    >
      {children}{" "}
      <ChevronDown
        className="relative top-[1px] ml-1 h-3 w-3 transition duration-200 group-data-[popup-open]:rotate-180"
        aria-hidden="true"
      />
    </NavigationMenuPrimitive.Trigger>
  )
}

function NavigationMenuContent({
  className,
  ...props
}: NavigationMenuPrimitive.Content.Props) {
  return (
    <NavigationMenuPrimitive.Content
      data-slot="navigation-menu-content"
      className={cn(
        "left-0 top-0 w-full p-0 transition-[opacity,transform] duration-200 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0 data-[starting-style]:data-[activation-direction=left]:-translate-x-1/2 data-[starting-style]:data-[activation-direction=right]:translate-x-1/2 data-[ending-style]:data-[activation-direction=left]:translate-x-1/2 data-[ending-style]:data-[activation-direction=right]:-translate-x-1/2 md:w-auto",
        className
      )}
      {...props}
    />
  )
}

function NavigationMenuLink(props: NavigationMenuPrimitive.Link.Props) {
  return (
    <NavigationMenuPrimitive.Link data-slot="navigation-menu-link" {...props} />
  )
}

/** The panel the open item's content renders into, below the list. */
function NavigationMenuViewport({
  className,
  side = "bottom",
  sideOffset = 6,
  align = "start",
  ...props
}: NavigationMenuPrimitive.Popup.Props &
  Pick<NavigationMenuPrimitive.Positioner.Props, "side" | "sideOffset" | "align">) {
  return (
    <NavigationMenuPrimitive.Portal>
      <NavigationMenuPrimitive.Positioner
        className="z-50 h-[var(--positioner-height)] w-[var(--positioner-width)] max-w-[var(--available-width)] transition-[top,left,right,bottom] duration-200 data-[instant]:transition-none"
        side={side}
        sideOffset={sideOffset}
        align={align}
      >
        <NavigationMenuPrimitive.Popup
          data-slot="navigation-menu-viewport"
          className={cn(
            "origin-[--transform-origin] relative h-[var(--popup-height)] w-full overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-lg transition-[opacity,transform,width,height] duration-200 data-[ending-style]:scale-90 data-[ending-style]:opacity-0 data-[starting-style]:scale-90 data-[starting-style]:opacity-0 md:w-[var(--popup-width)]",
            className
          )}
          {...props}
        >
          <NavigationMenuPrimitive.Arrow className="flex h-1.5 items-end justify-center overflow-hidden data-[side=bottom]:-top-1.5">
            <div className="relative top-[60%] h-2 w-2 rotate-45 rounded-tl-sm bg-border shadow-md" />
          </NavigationMenuPrimitive.Arrow>
          <NavigationMenuPrimitive.Viewport className="relative h-full w-full overflow-hidden" />
        </NavigationMenuPrimitive.Popup>
      </NavigationMenuPrimitive.Positioner>
    </NavigationMenuPrimitive.Portal>
  )
}

/**
 * Kept for API compatibility. The viewport draws the arrow under the open
 * trigger itself, so this renders nothing.
 */
function NavigationMenuIndicator(_props: React.ComponentProps<"div">) {
  return null
}

export {
  navigationMenuTriggerStyle,
  NavigationMenu,
  NavigationMenuList,
  NavigationMenuItem,
  NavigationMenuContent,
  NavigationMenuTrigger,
  NavigationMenuLink,
  NavigationMenuIndicator,
  NavigationMenuViewport,
}
