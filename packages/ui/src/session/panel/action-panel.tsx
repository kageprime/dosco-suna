'use client';

/**
 * The action panel column's root (`session-action-panel-column.tsx` renders it
 * beside the chat). It takes no props: everything the sections below need
 * comes from `SessionPanelProvider`, which owns the session's panel state for
 * both surfaces.
 *
 * ADVANCED PANEL TEMPORARILY DISABLED: Easy is the one panel presentation
 * (Easy Panel v2 spec, 2026-07-17). On desktop the Easy panel is the plan's
 * ONLY surface (`planBelongsToChat` in turn/plan-anchor.ts): restoring
 * `AdvancedPanel` without a Plan card of its own hides the plan.
 */

import { EasyPanel } from './easy/easy-panel';

export function ActionPanel() {
  return <EasyPanel />;
}
