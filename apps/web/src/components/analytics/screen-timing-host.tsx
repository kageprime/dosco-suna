'use client';

/**
 * Feeds route changes and React Query activity into the `screen_ready`
 * timer (lib/analytics/screen-timing.ts). Renders nothing. Not a dynamic
 * chunk: it must see the first route's requests, which start at hydration.
 */

import { screenTimer } from '@/lib/analytics/screen-timing';
import { track } from '@/lib/track';
import { useQueryClient } from '@tanstack/react-query';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';

export function ScreenTimingHost() {
  const pathname = usePathname();
  const queryClient = useQueryClient();
  // Created during render, before any page effect can call `markScreenReady`.
  const [timer] = useState(() =>
    screenTimer(
      (event) => track('screen_ready', event),
      () => queryClient.isFetching(),
    ),
  );

  // `pathname` only triggers the effect. The path itself comes from the same
  // source `markScreenReady` reads, so a mark and this effect agree on it.
  useEffect(() => {
    if (document.visibilityState === 'hidden') {
      timer.abandon();
      return;
    }
    timer.navigate(window.location.pathname, queryClient.isFetching());
  }, [pathname, queryClient, timer]);

  useEffect(() => {
    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      const started = event.type === 'updated' && event.action.type === 'fetch';
      timer.queries(started, queryClient.isFetching());
    });
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') timer.abandon();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      unsubscribe();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [queryClient, timer]);

  return null;
}
