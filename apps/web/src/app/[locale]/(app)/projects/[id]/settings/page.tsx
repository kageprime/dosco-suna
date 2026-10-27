import { UnifiedSettingsPage } from '@/features/workspace/settings/unified-settings-page';

/**
 * /projects/[id]/settings — Unified Settings & Customization Hub (T3 Chat Paradigm).
 * Merges persona customization, models, API keys, capabilities, account, and preferences
 * into a single full-screen surface with persistent HUD and conversational form design.
 */
export default async function ProjectSettingsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <UnifiedSettingsPage projectId={id} />;
}
