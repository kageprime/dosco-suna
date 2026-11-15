import 'server-only';

import type { Metadata } from 'next';

import { createScopedKortix } from '@kortix/sdk/server';

import { getTranslations } from '@/i18n/get-translations';
import { settleWithin } from '@/lib/deadline';
import { getServerPublicEnv } from '@/lib/public-env-server';
import { createClient } from '@/lib/supabase/server';

import { workspaceSettingsSectionLabelKey, workspaceSettingsTabTitle } from './workspace-settings-title';

/**
 * Tab titles for `/workspaces/[id]/admin/**`. They live in the route's
 * layouts, not in a client effect: React re-asserts the metadata-owned
 * `<title>` after client effects run, so a `document.title` write on load is
 * overwritten (see `session-tab-title-server.ts`).
 *
 * `admin/layout.tsx` sets the template with the workspace name; each section
 * layout sets only the section's label.
 */

/** A backstop against a stalled API; `GET /workspaces/:id` is one row read. */
const NAME_BUDGET_MS = 1_500;

/** The workspace's name, or `null`. Never throws: a wrong tab title is never worth a failed route. */
async function workspaceName(projectId: string): Promise<string | null> {
  try {
    const supabase = await createClient();
    const {
      data: { session: auth },
    } = await supabase.auth.getSession();
    const accessToken = auth?.access_token;
    const backendUrl = getServerPublicEnv().BACKEND_URL;
    if (!accessToken || !backendUrl) return null;
    // Scoped, never the process-global client: two users' requests can be in flight at once.
    const kortix = createScopedKortix({ backendUrl, getToken: async () => accessToken });
    const project = await settleWithin(
      kortix.project(projectId).get({ showErrors: false }),
      NAME_BUDGET_MS,
      () => null,
    );
    return project?.name ?? null;
  } catch {
    return null;
  }
}

/** `admin/layout.tsx`: "Workspace settings · <name>", and the template every section fills. */
export async function workspaceSettingsMetadata(projectId: string): Promise<Metadata> {
  const t = await getTranslations('workspaces.settings');
  const workspace = await workspaceName(projectId);
  const settings = t('title');
  return {
    title: {
      // `absolute`: the root layout's "| Kortix CompanyOS" template does not apply.
      absolute: workspaceSettingsTabTitle({ settings, workspace }),
      template: workspaceSettingsTabTitle({ section: '%s', settings, workspace }),
    },
  };
}

/** A section layout: the section's rail label, filled into the admin template. */
export async function workspaceSettingsSectionMetadata(segment: string): Promise<Metadata> {
  const key = workspaceSettingsSectionLabelKey(segment);
  if (!key) return {};
  const t = await getTranslations('workspaces.settings');
  return { title: t(`sections.${key}` as never) };
}
