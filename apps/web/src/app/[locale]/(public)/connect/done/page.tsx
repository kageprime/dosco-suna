'use client';

import { ConnectorReturn, readConnectorReturnParams } from '@/components/setup-links/connector-return';
import { AuthFrame } from '@kortix/ui/internal/auth/auth-card-shell';
import { Rise } from '@kortix/ui/internal/auth/auth-primitives';
import { useSearchParams } from 'next/navigation';

/** The result of a connector sign-in that named no return page, in the connect link's frame. */
export default function ConnectorReturnPage() {
  const params = readConnectorReturnParams(new URLSearchParams(useSearchParams().toString()));
  return (
    <AuthFrame footerVariant="none">
      <Rise>
        <ConnectorReturn params={params} />
      </Rise>
    </AuthFrame>
  );
}
