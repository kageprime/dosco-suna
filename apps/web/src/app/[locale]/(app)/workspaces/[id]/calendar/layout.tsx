'use client';

import { useParams } from 'next/navigation';
import type { ReactNode } from 'react';

import { useTranslations } from '@/i18n/use-translations';
import { FeatureGateScreen } from '@kortix/ui/customize/shared/feature-gate-screen';
import { useFeatureFlag } from '@kortix/sdk/react';

/**
 * /workspaces/[id]/calendar — the workspace calendar. It exists only with the
 * project's `calendar` flag on: off, a deep link shows only that the flag is
 * off, and no calendar data loads.
 */
export default function ProjectCalendarLayout({ children }: { children: ReactNode }) {
  const { id } = useParams<{ id: string }>();
  const t = useTranslations('calendar');
  const calendar = useFeatureFlag(id, 'calendar');

  if (calendar.isLoading) return null;
  if (!calendar.enabled) {
    return (
      <div className="mx-auto w-full max-w-3xl p-4">
        <FeatureGateScreen featureKey="calendar" featureName={t('title')} description={t('gateDescription')} />
      </div>
    );
  }
  return <>{children}</>;
}
