'use client';

import { HoverPrefetchLink } from '../components/hover-prefetch-link';
import { SidebarMenuButton, SidebarMenuItem, useSidebar } from '../../primitives/sidebar';
import { useIsMobile } from '../hooks';
import { cn } from '../lib/utils';
import type { ComponentProps, ReactNode } from 'react';

/** Keep the anchor's intent handlers and the caller's active-route semantics. */
export function ProjectNavRow({
  active,
  label,
  className,
  itemClassName,
  children,
  ...link
}: ComponentProps<typeof HoverPrefetchLink> & {
  active: boolean;
  label: string;
  /** Added to the row button's classes. */
  className?: string;
  /** Added to the list item's classes (spacing around the row). */
  itemClassName?: string;
  children: ReactNode;
}) {
  const isMobile = useIsMobile();
  const { setOpenMobile } = useSidebar();
  return (
    <SidebarMenuItem className={itemClassName}>
      <SidebarMenuButton
        asChild
        isActive={active}
        tooltip={label}
        className={cn(
          'group/menu-button text-sidebar-foreground relative group-data-[collapsible=icon]:!justify-center group-data-[collapsible=icon]:!p-0',
          className,
        )}
      >
        <HoverPrefetchLink
          {...link}
          className={cn(
            'flex w-full items-center gap-2 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:gap-0',
          )}
          onClick={(event) => {
            link.onClick?.(event);
            if (isMobile) setOpenMobile(false);
          }}
        >
          {children}
        </HoverPrefetchLink>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}
