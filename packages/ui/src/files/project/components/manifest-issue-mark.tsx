'use client';

import { WarningIcon } from '@phosphor-icons/react';

import { useTranslations } from '../../../i18n';
import { cn } from '../../../lib/utils';
import Hint from '../../../primitives/hint';
import { useFileAnnotations } from '../../viewer/file-annotations';

/**
 * A file card's mark for open issues in that file (`FileAnnotationsProvider`):
 * the warning colour with an error, muted with warnings only, the same tones as
 * the sidebar row. The tooltip says what the file has. Nothing without issues.
 */
export function ManifestIssueMark({ path, name }: { path: string; name: string }) {
  const t = useTranslations('sidebar.manifestIssues');
  const diagnostics = useFileAnnotations(path);
  if (diagnostics.length === 0) return null;
  const errors = diagnostics.filter((d) => d.severity === 1).length;
  const warnings = diagnostics.length - errors;
  const label = t(warnings === 0 ? 'titleErrors' : errors === 0 ? 'titleWarnings' : 'title', {
    file: name,
    errors,
    warnings,
  });
  return (
    <Hint label={label} side="top">
      <span role="img" aria-label={label} data-slot="manifest-issue-mark" className="inline-flex shrink-0">
        <WarningIcon
          className={cn('size-3.5', errors > 0 ? 'text-kortix-orange' : 'text-muted-foreground')}
        />
      </span>
    </Hint>
  );
}
