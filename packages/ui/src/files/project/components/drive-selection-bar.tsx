'use client';

import { useTranslations } from '../../../i18n';
import { SelectionBar, type SelectionBarAction } from '../../../internal/selection/selection-bar';
import { useSyncExternalStore } from 'react';

import type { SelectionStore } from './drive-selection';

/**
 * The Drive's select-mode bar: the shared `SelectionBar` (an `ActionBar`) with
 * Download, then Copy, Move and Delete for members who may write. It reads the
 * count from the selection store itself, so only the bar re-renders as the
 * count moves.
 */
export function DriveSelectionBar({
  store,
  total,
  zipping,
  canWrite,
  onSelectAll,
  onClearSelection,
  onDownload,
  onCopy,
  onMove,
  onDelete,
  onExit,
}: {
  store: SelectionStore;
  /** Items in view, for "Select all" vs "Deselect all". */
  total: number;
  zipping: boolean;
  canWrite: boolean;
  onSelectAll: () => void;
  onClearSelection: () => void;
  onDownload: () => void;
  onCopy: () => void;
  onMove: () => void;
  onDelete: () => void;
  onExit: () => void;
}) {
  const t = useTranslations('drives');
  const count = useSyncExternalStore(store.subscribe, () => store.paths().size, () => 0);
  const none = count === 0;
  const actions: SelectionBarAction[] = [
    { id: 'download', label: t('download'), loading: zipping, disabled: none, onSelect: onDownload },
  ];
  if (canWrite) {
    actions.push(
      { id: 'copy', label: t('copyItems'), disabled: none, onSelect: onCopy },
      { id: 'move', label: t('moveItems'), disabled: none, onSelect: onMove },
      { id: 'delete', label: t('delete'), tone: 'destructive', disabled: none, onSelect: onDelete },
    );
  }
  return (
    <SelectionBar
      selectedCount={count}
      allSelected={total > 0 && count === total}
      canSelectAll={total > 0}
      onSelectAll={onSelectAll}
      onClear={onClearSelection}
      onExit={onExit}
      actions={actions}
    />
  );
}
