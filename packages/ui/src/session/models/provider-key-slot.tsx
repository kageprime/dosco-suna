'use client';

import { PROVIDER_LABELS } from '../../internal/lib/provider-branding';
import { Button } from '../../primitives/button';
import { useTranslations } from '../../i18n';
import { useModelConnectionGate } from './use-model-connection-gate';

/**
 * The fix for a turn that failed on a provider key: Models → Providers, open
 * on that provider, where the key is added, replaced or checked. Renders on a
 * project route only (`useModelConnectionGate`).
 */
export function ProviderKeySlot({ providerId, className = 'mt-2 pl-7' }: { providerId: string; className?: string }) {
  const t = useTranslations('pooledSecrets');
  const { canConnectProvider, openConnectProvider, modal } = useModelConnectionGate();
  if (!canConnectProvider) return null;
  const name = PROVIDER_LABELS[providerId] ?? providerId;
  return (
    <div className={className}>
      {modal}
      <Button size="sm" className="active:scale-[0.96]" onClick={() => openConnectProvider('providers', providerId)}>
        {t('openProviderInModels', { provider: name })}
      </Button>
    </div>
  );
}
