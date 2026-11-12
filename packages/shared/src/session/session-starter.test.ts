import { describe, expect, test } from 'bun:test';

import { classifySessionStarter } from './session-starter';

/**
 * Pins the shared session-starter classification (KRTX-4772): the same
 * expectations first ran against mobile `sessionStarter` and web
 * `sessionStarter` before the extraction. The host suites still pin each
 * host's wording and icons.
 */
const row = (overrides: Record<string, unknown> = {}) => ({
  initiator: null,
  created_by: null,
  is_owner: undefined,
  owner_name: null,
  owner_email: null,
  ...overrides,
});

describe('classifySessionStarter', () => {
  test('member: the viewer, another member, an unnamed member', () => {
    expect(classifySessionStarter(row({ initiator: { type: 'member', id: 'u1', label: 'Ada' } }), 'u1')).toEqual({
      type: 'member',
      id: 'u1',
      isViewer: true,
      label: 'Ada',
    });
    expect(
      classifySessionStarter(row({ initiator: { type: 'member', id: 'u2', label: 'Ada' } }), 'u1'),
    ).toEqual({ type: 'member', id: 'u2', isViewer: false, label: 'Ada' });
    expect(
      classifySessionStarter(row({ initiator: { type: 'member', id: 'u3', label: null } }), 'u1'),
    ).toEqual({ type: 'member', id: 'u3', isViewer: false, label: null });
  });

  test('a run another member started on the viewer-created child is never the viewer', () => {
    expect(
      classifySessionStarter(
        row({ initiator: { type: 'member', id: 'u2', label: 'Bo' }, created_by: 'u1', is_owner: true }),
        'u1',
      ),
    ).toEqual({ type: 'member', id: 'u2', isViewer: false, label: 'Bo' });
  });

  test('trigger, channel (every id), api and system keep type, id and label', () => {
    expect(
      classifySessionStarter(row({ initiator: { type: 'trigger', id: 'nightly', label: 'nightly' } }), 'u1'),
    ).toEqual({ type: 'trigger', id: 'nightly', isViewer: false, label: 'nightly' });
    for (const id of ['slack', 'teams', 'email', 'telegram', 'discord', 'xmpp']) {
      expect(classifySessionStarter(row({ initiator: { type: 'channel', id, label: 'Slack' } }), 'u1')).toEqual({
        type: 'channel',
        id,
        isViewer: false,
        label: 'Slack',
      });
    }
    expect(classifySessionStarter(row({ initiator: { type: 'api', id: 'sa1', label: 'CI key' } }), 'u1')).toEqual({
      type: 'api',
      id: 'sa1',
      isViewer: false,
      label: 'CI key',
    });
    expect(
      classifySessionStarter(row({ initiator: { type: 'system', id: 'system:x', label: 'Kortix' } }), 'u1'),
    ).toEqual({ type: 'system', id: 'system:x', isViewer: false, label: 'Kortix' });
  });

  test('null initiator reads as a member of the creator; the viewer rule holds', () => {
    expect(classifySessionStarter(row({ created_by: 'u1' }), 'u1')).toEqual({
      type: 'member',
      id: 'u1',
      isViewer: true,
      label: null,
    });
    expect(classifySessionStarter(row({ created_by: 'u1', is_owner: false }), 'u2')).toEqual({
      type: 'member',
      id: 'u1',
      isViewer: false,
      label: null,
    });
    expect(classifySessionStarter(row({ created_by: 'u1' }), null).isViewer).toBe(false);
    expect(classifySessionStarter(row({ created_by: 'u1' }), undefined).isViewer).toBe(false);
  });
});
