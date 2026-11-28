import { locales } from '@/i18n/catalog.mjs';

/** Carry only an internal workspace/account route, never an external URL or Inbox loop. */
export function inboxReturnHref(from: string | null): string {
  if (!from || !from.startsWith('/') || /[\\\u0000-\u0020]/.test(from)) return '/workspaces';
  try {
    const url = new URL(from, 'https://kortix.test');
    const segments = url.pathname.split('/');
    const pathname = locales.some((locale) => locale === segments[1])
      ? `/${segments.slice(2).join('/')}`
      : url.pathname;
    if (
      url.origin !== 'https://kortix.test' ||
      !/^\/(workspaces|projects)(\/|$)/.test(pathname)
    ) {
      return '/workspaces';
    }
    return url.pathname + url.search + url.hash;
  } catch {
    return '/workspaces';
  }
}

export function inboxHref(from: string): string {
  return `/inbox?${new URLSearchParams({ from: inboxReturnHref(from) })}`;
}
