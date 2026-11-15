import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { workspaceSettingsMetadata } from '@/features/workspace/project-admin/workspace-settings-metadata';

type AdminLayoutProps = { children: ReactNode; params: Promise<{ id: string }> };

/**
 * Workspace settings' tab title: "<Section> · Workspace settings · <workspace>".
 * The pages are client components, so the title lives in layouts: this one
 * sets the template, each section's layout fills in its label.
 */
export async function generateMetadata({ params }: AdminLayoutProps): Promise<Metadata> {
  const { id } = await params;
  return workspaceSettingsMetadata(id);
}

export default function WorkspaceSettingsLayout({ children }: AdminLayoutProps) {
  return children;
}
