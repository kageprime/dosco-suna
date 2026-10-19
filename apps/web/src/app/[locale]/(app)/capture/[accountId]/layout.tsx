import type { Metadata } from 'next';

import { CaptureAreaShell } from '@/features/capture/area/capture-area-shell';

export const metadata: Metadata = {
  title: { absolute: 'Dosco Capture', template: '%s · Dosco Capture' },
  robots: { index: false, follow: false },
};

/**
 * /capture/[accountId] — Dosco Capture for one organization (Dosco account):
 * Devices, a device's timeline, This computer and Organization settings.
 * Its own top bar; no project sidebar.
 */
export default async function CaptureLayout({
  params,
  children,
}: {
  params: Promise<{ accountId: string }>;
  children: React.ReactNode;
}) {
  const { accountId } = await params;
  return <CaptureAreaShell accountId={accountId}>{children}</CaptureAreaShell>;
}
