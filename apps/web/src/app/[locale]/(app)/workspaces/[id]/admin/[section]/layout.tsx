import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { workspaceSettingsSectionMetadata } from '@/features/workspace/project-admin/workspace-settings-metadata';

type SectionLayoutProps = { children: ReactNode; params: Promise<{ section: string }> };

/** The section's rail label, in the template `admin/layout.tsx` sets. */
export async function generateMetadata({ params }: SectionLayoutProps): Promise<Metadata> {
  const { section } = await params;
  let segment = section;
  try {
    segment = decodeURIComponent(section);
  } catch {
    // A malformed escape names no section: the page says so, the tab keeps the default.
  }
  return workspaceSettingsSectionMetadata(segment);
}

export default function WorkspaceSettingsSectionLayout({ children }: SectionLayoutProps) {
  return children;
}
