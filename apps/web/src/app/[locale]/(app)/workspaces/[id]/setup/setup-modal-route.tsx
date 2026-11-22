'use client';

import { uiRoutes } from '@kortix/ui';
import { WorkspaceSetupModal } from '@kortix/ui/workspace/setup/workspace-setup-modal';
import { useParams, usePathname, useRouter } from 'next/navigation';

/**
 * The setup modal at `/workspaces/<id>/setup`, in either of its two mounts:
 *
 * - `intercepted`: a link inside the workspace (the home banner) opened it.
 *   `@modal/(.)setup` draws it over the page it came from; closing goes back.
 * - `page`: the URL loaded directly (`kortix onboard`, a refresh). `setup/page.tsx`
 *   draws it over the workspace home; closing replaces the URL with home.
 *
 * A soft navigation out of the modal (a row's link to a connector page) keeps
 * the parallel slot's last state, so the modal draws only while the URL is
 * still the setup URL.
 */
export function SetupModalRoute({ mode }: { mode: 'intercepted' | 'page' }) {
  const { id: projectId } = useParams<{ id: string }>();
  const pathname = usePathname();
  const router = useRouter();
  if (!pathname.endsWith('/setup')) return null;
  const close = () => {
    if (mode === 'intercepted') router.back();
    else router.replace(uiRoutes().project(projectId));
  };
  return <WorkspaceSetupModal projectId={projectId} onClose={close} />;
}
