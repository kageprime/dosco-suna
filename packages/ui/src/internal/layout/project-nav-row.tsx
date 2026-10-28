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
  children,
  ...link
}: ComponentProps<typeof HoverPrefetchLink> & {
  active: boolean;
  label: string;
  children: ReactNode;
}) {
  const isMobile = useIsMobile();
  const { setOpenMobile } = useSidebar();
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        asChild
        isActive={active}
        tooltip={label}
        className="group/menu-button text-sidebar-foreground relative group-data-[collapsible=icon]:!justify-center group-data-[collapsible=icon]:!p-0"
      >
        <HoverPrefetchLink
          {...link}
          className={cn(
            'flex w-full items-center gap-2 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:gap-0',
            link.className,
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
