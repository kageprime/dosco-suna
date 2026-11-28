'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import type { ComponentProps } from 'react';
import { inboxHref } from './inbox-navigation';

/** Both Inbox entry points preserve the page, including its query and fragment. */
export function InboxLink(props: Omit<ComponentProps<typeof Link>, 'href' | 'onNavigate'>) {
  const pathname = usePathname();
  const search = useSearchParams();
  const router = useRouter();
  return (
    <Link
      {...props}
      href={inboxHref(`${pathname}${search.size ? `?${search}` : ''}`)}
      onNavigate={(event) => {
        event.preventDefault();
        router.push(
          inboxHref(window.location.pathname + window.location.search + window.location.hash),
        );
      }}
    />
  );
}
