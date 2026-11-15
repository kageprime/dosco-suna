'use client';

/**
 * The select-mode bar shared by every multi-select list: an `ActionBar` whose
 * title is the count, whose first action is Select all / Deselect all, then the
 * caller's actions, then the exit ×. While a bulk action runs, the title reads
 * its progress, the session dot matrix leads, and every control disables.
 */

import { useTranslations } from '../../i18n';
import { ActionBar, type ActionBarAction } from '../../primitives/action-bar';

export type SelectionBarAction = ActionBarAction;

export function SelectionBar({
  selectedCount,
  allSelected,
  canSelectAll = true,
  onSelectAll,
  onClear,
  onExit,
  actions,
  progress = null,
  animateIn = true,
  note,
}: {
  selectedCount: number;
  allSelected: boolean;
  /** False when the list shows nothing to select. */
  canSelectAll?: boolean;
  onSelectAll: () => void;
  onClear: () => void;
  onExit: () => void;
  actions: readonly SelectionBarAction[];
  /**
   * A running bulk action: `label` is the full progress line ("Pausing 3 of 12…").
   * `done` and `total` ride along for consumers that render their own label.
   */
  progress?: { label: string; done: number; total: number } | null;
  /** False skips the enter animation (select mode opened from the keyboard). */
  animateIn?: boolean;
  /** A muted line after the count, such as a selection limit. */
  note?: string;
}) {
  const t = useTranslations('hardcodedUi.i18nComplete');
  return (
    <ActionBar
      title={progress ? progress.label : t('text1cc5b0d9628f', { count: selectedCount })}
      description={progress ? undefined : note}
      busy={progress !== null}
      animateIn={animateIn}
      actions={[
        {
          id: 'select-all',
          label: allSelected ? t.raw('text83b12c2216ef') : t.raw('text1fc9a387654d'),
          disabled: !canSelectAll,
          onSelect: allSelected ? onClear : onSelectAll,
        },
        ...actions,
      ]}
      close={{ label: t.raw('text22206bc67806'), onSelect: onExit }}
    />
  );
}
