'use client';

import { useCaptureDirectory } from '@kortix/ui/internal/capture/use-capture-area';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@kortix/ui/select';
import { useTranslations } from '@/i18n/use-translations';

/** The Select value for "linked to no one". */
const NO_ONE = 'none';

/** A member of the account, or "linked to no one". */
export function MemberSelect({
  accountId,
  enabled,
  value,
  noneLabel,
  labelledBy,
  onChange,
}: {
  accountId: string;
  enabled: boolean;
  value: string | null;
  /** The label of the null choice; default "Linked to no one". */
  noneLabel?: string;
  labelledBy?: string;
  onChange: (userId: string | null) => void;
}) {
  const t = useTranslations('capture.rollout');
  const people = useCaptureDirectory(accountId, enabled);
  return (
    <Select
      value={value ?? NO_ONE}
      onValueChange={(next) => onChange(next === NO_ONE ? null : next)}
    >
      <SelectTrigger
        aria-label={labelledBy ? undefined : t('member')}
        aria-labelledby={labelledBy}
        className="w-full"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NO_ONE}>{noneLabel ?? t('noOne')}</SelectItem>
        {people.members.map((member) => (
          <SelectItem key={member.user_id} value={member.user_id}>
            {member.email ?? member.user_id}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
