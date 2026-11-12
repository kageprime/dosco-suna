'use client';

import { ConnectorIntake } from '@/components/setup-links/connector-intake';
import { AuthFrame } from '@kortix/ui/internal/auth/auth-card-shell';
import { Rise } from '@kortix/ui/internal/auth/auth-primitives';
import { useParams, useSearchParams } from 'next/navigation';

/** The quiet auth frame, like `/approve/[token]`: the Kortix ··· App handshake, the heading, the connect step. */
export default function ConnectIntakePage() {
  const params = useParams();
  const token = Array.isArray(params.token) ? params.token[0] : (params.token as string);
  // The provider sends an agent-started sign-in back here with `?returned=1`:
  // the page finishes it instead of offering Connect again.
  const returned = useSearchParams().get('returned') === '1';

  return (
    <AuthFrame footerVariant="none">
      <Rise>
        <ConnectorIntake token={token} returned={returned} />
      </Rise>
    </AuthFrame>
  );
}
