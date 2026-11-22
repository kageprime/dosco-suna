'use client';

import { getChangeRequest } from '@kortix/sdk';
import { changeRequestReviewPath } from '@kortix/shared/change-request-links';
import { Button } from '@kortix/ui/button';
import { ErrorState } from '@kortix/ui/error-state';
import { useQuery } from '@tanstack/react-query';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect } from 'react';

import { useTranslations } from '@/i18n/use-translations';

import { ProjectPendingScreen } from './project-pending-screen';

/** UUID links need no read; numbers use the scoped API. Client navigation keeps fragments. */
export function ChangeRequestLink({ workspaceId, crRef }: { workspaceId: string; crRef: string }) {
  const router = useRouter();
  const t = useTranslations('sessionChangeRequests');
  const common = useTranslations('common');
  const search = useSearchParams().toString();
  const isUuid = crRef.includes('-');
  const cr = useQuery({
    queryKey: ['change-request-link', workspaceId, crRef],
    queryFn: () => getChangeRequest(workspaceId, crRef),
    retry: false,
    enabled: !isUuid,
  });
  const crId = isUuid ? crRef : cr.data?.change_request.cr_id;
  useEffect(() => {
    if (crId) router.replace(changeRequestReviewPath(workspaceId, crId, new URLSearchParams(search)) + window.location.hash);
  }, [crId, workspaceId, search, router]);
  if (cr.isError) return <ErrorState size="sm" title={t('openError')} action={<Button variant="outline" size="sm" disabled={cr.isFetching} aria-busy={cr.isFetching} onClick={() => void cr.refetch()}>{common('retry')}</Button>} />;
  return <ProjectPendingScreen fill="pane" />;
}
