import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { desktopShellPath, isDesktopShell } from '@/lib/workspace-redirects';

import { notificationsRedirectTarget } from './notifications-redirect';

export default async function WorkspaceInboxPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const { view } = query;
  const target = notificationsRedirectTarget(typeof view === 'string' ? view : null);
  if (target) redirect(target);
  const remaining = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (key === 'view' || value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) remaining.append(key, item);
  }
  const search = remaining.toString();
  const destination = `/workspaces/${id}/review${search ? `?${search}` : ''}`;
  const userAgent = (await headers()).get('user-agent');
  redirect(isDesktopShell(userAgent) ? desktopShellPath(destination) : destination);
}
