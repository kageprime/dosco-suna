import { Badge } from '../../../primitives/badge';
import { useTranslations } from '../../../i18n';
import { cn } from '../../../internal/lib/utils';

import { STATUS_DOT, STATUS_WORD, type ConnectorTone } from './connector-status';

const STATUS_BADGE = {
  connected: 'success',
  account: 'warning',
  error: 'destructive',
  no_tools: 'warning',
} as const;

/** A connector's state as a Badge with its dot: Connected, Needs account, No tools or Error. */
export function ConnectorStatusBadge({ tone }: { tone: ConnectorTone }) {
  const t = useTranslations('connectorPages');
  return (
    <Badge variant={STATUS_BADGE[tone]} size="sm">
      <span data-slot="status-dot" aria-hidden className={cn('rounded-full', STATUS_DOT[tone])} />
      {t(STATUS_WORD[tone])}
    </Badge>
  );
}
