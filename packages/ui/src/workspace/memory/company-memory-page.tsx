'use client';

import { useTranslations } from '../../i18n';
import { ProjectPageHeader } from '../../internal/layout/project-page-header';
import { MemoryView } from './memory-view';

/**
 * The project's Memory page: the Company layer, what every agent in the
 * project knows. The titlebar row of a channel, then the same `MemoryView` a
 * channel's Memory tab draws. The host gates it on `chat`.
 */
export function CompanyMemoryPage({ projectId }: { projectId: string }) {
  const t = useTranslations('spaces.memory.company');
  return (
    <div className="bg-background flex min-h-0 flex-1 flex-col overflow-hidden">
      <ProjectPageHeader
        title={t('title')}
        titleAccessory={<p className="text-muted-foreground min-w-0 truncate text-xs">{t('subtitle')}</p>}
      />
      {/* Out of flow, as in a channel: the shell's wrapper is `min-h-svh`, so a body with an
          intrinsic height (the All cards) would grow the page and scroll this header away. */}
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <div className="absolute inset-0 flex flex-col">
          <MemoryView projectId={projectId} layerKey="company" place={t('place')} />
        </div>
      </div>
    </div>
  );
}
