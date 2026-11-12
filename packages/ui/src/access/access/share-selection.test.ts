import { describe, expect, test } from 'bun:test';

import { planConnectionShare, type ConnectionShare } from '@kortix/sdk';

import { EMPTY_PRINCIPAL_SELECTION } from './principal-picker';
import { applyShareSelection, shareSelectionView } from './share-selection';

const worker: ConnectionShare = {
  grant_id: 'g-worker',
  principal_type: 'agent',
  principal_id: 'sa-worker',
  label: 'worker',
  expires_at: null,
};
const owner: ConnectionShare = {
  grant_id: 'g-owner',
  principal_type: 'member',
  principal_id: 'u-owner',
  label: 'owner@example.test',
  expires_at: null,
};
const current = [worker, owner];
const none = new Set<string>();

describe('share dialog selection', () => {
  test('the picker shows every principal that has access as checked', () => {
    const view = shareSelectionView(current, none, EMPTY_PRINCIPAL_SELECTION);
    expect(view.agentIds).toEqual(['sa-worker']);
    expect(view.memberIds).toEqual(['u-owner']);
  });

  test('clicking an agent that has access removes it, and Save has a change', () => {
    const view = shareSelectionView(current, none, EMPTY_PRINCIPAL_SELECTION);
    const next = applyShareSelection(current, none, { ...view, agentIds: [] });
    expect([...next.removed]).toEqual(['g-worker']);
    expect(next.picked.agentIds ?? []).toEqual([]);
    const plan = planConnectionShare(current, next.removed, next.picked, 'p');
    expect(plan).toEqual({ add: [], revoke: ['g-worker'] });
  });

  test('Remove (X) then the picker: the agent reads unchecked, and Save has a change', () => {
    const removed = new Set(['g-worker']);
    const view = shareSelectionView(current, removed, EMPTY_PRINCIPAL_SELECTION);
    expect(view.agentIds ?? []).toEqual([]);
    const plan = planConnectionShare(current, removed, EMPTY_PRINCIPAL_SELECTION, 'p');
    expect(plan.revoke).toEqual(['g-worker']);
  });

  test('checking a removed agent again keeps its grant (no change)', () => {
    const removed = new Set(['g-worker']);
    const view = shareSelectionView(current, removed, EMPTY_PRINCIPAL_SELECTION);
    const next = applyShareSelection(current, removed, { ...view, agentIds: ['sa-worker'] });
    expect(next.removed.size).toBe(0);
    expect(next.picked.agentIds ?? []).toEqual([]);
  });

  test('a new pick is an addition', () => {
    const view = shareSelectionView(current, none, EMPTY_PRINCIPAL_SELECTION);
    const next = applyShareSelection(current, none, { ...view, groupIds: ['grp-1'] });
    expect(next.picked.groupIds).toEqual(['grp-1']);
    expect(next.removed.size).toBe(0);
  });
});
