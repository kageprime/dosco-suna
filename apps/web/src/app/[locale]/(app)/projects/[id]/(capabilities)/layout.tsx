'use client';

import { useParams } from 'next/navigation';

import { CapabilityAccessGate } from '@kortix/ui/customize/shared/capability-access-gate';
import { CapabilityTabs } from '@kortix/ui/customize/shared/capability-tabs';
import { CustomizeSidebar } from '@kortix/ui/customize';

/**
 * Shared shell for /projects/[id]/{agent,connectors,skills,triggers,models,
 * secrets,review,members,customize}.
 *
 * Implements the Supabase-style double sidebar layout:
 * - On desktop viewports (@2xl+), CustomizeSidebar renders as a dedicated secondary
 *   vertical rail, eliminating horizontal tab bars and consolidating settings.
 * - On compact viewports (<@2xl), CustomizeSidebar collapses and CapabilityTabs provides
 *   an accessible horizontal scroll bar.
 */
export default function CapabilitiesLayout({ children }: { children: React.ReactNode }) {
  const { id: projectId } = useParams<{ id: string }>();

  return (
    <div className="@container flex h-svh min-h-0 flex-1 overflow-hidden">
      <CustomizeSidebar projectId={projectId} className="hidden @2xl:flex" />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <div className="@2xl:hidden shrink-0">
          <CapabilityTabs projectId={projectId} />
        </div>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <CapabilityAccessGate projectId={projectId}>{children}</CapabilityAccessGate>
        </div>
      </div>
    </div>
  );
}
