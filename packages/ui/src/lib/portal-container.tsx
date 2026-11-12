'use client';

import * as React from 'react';

/**
 * Where overlays portal to. Unset (the default), every overlay portals to
 * document.body. ThemeScope sets it to an element inside its
 * subtree, so a dialog, popover or menu opened in a scope paints the scope's
 * tokens instead of the page's.
 */
const PortalContainerContext = React.createContext<HTMLElement | null>(null);

export const PortalContainerProvider = PortalContainerContext.Provider;

export function usePortalContainer(): HTMLElement | undefined {
  return React.useContext(PortalContainerContext) ?? undefined;
}

/** Wraps a Base UI Portal so it defaults `container` to the nearest ThemeScope. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function withPortalContainer<C extends React.ComponentType<any>>(Portal: C) {
  function ScopedPortal(props: React.ComponentProps<C>) {
    const scoped = usePortalContainer();
    const Component = Portal as React.ComponentType<React.ComponentProps<C>>;
    return <Component {...props} container={props.container ?? scoped} />;
  }
  ScopedPortal.displayName = `Scoped(${Portal.displayName ?? Portal.name ?? 'Portal'})`;
  return ScopedPortal;
}
