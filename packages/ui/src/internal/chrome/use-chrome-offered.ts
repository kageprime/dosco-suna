'use client';

import { listChromeConnections } from '@kortix/sdk';
import { chromeKeys } from '@kortix/sdk/react';
import { useQuery } from '@tanstack/react-query';

/**
 * Whether this platform offers Kortix in Chrome at all. The API answers 404
 * on /v1/chrome/* where KORTIX_CHROME_ENABLED is off (a self-hosted server), so the
 * account-level surfaces — Settings → Kortix in Chrome and its command-palette
 * entry — show only once the browser list answers. Project surfaces read the
 * project's `chrome` flag instead.
 *
 * `true` once the browser list answers, `false` when it fails, `undefined`
 * while it loads: a page opened at `/settings/chrome` waits for the answer
 * instead of falling back to another tab.
 *
 * `enabled`: ask only while the surface that needs the answer is open.
 */
export function useChromeOffered(enabled = true): boolean | undefined {
  const query = useQuery({
    queryKey: chromeKeys.list(),
    queryFn: listChromeConnections,
    enabled,
    staleTime: 60_000,
    retry: false,
  });
  if (query.isSuccess) return true;
  if (query.isError) return false;
  return undefined;
}
