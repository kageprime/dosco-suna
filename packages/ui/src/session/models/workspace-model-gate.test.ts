import { describe, expect, test } from 'bun:test';

import { resolveWorkspaceModelGate } from './workspace-model-gate';

const runnable = { enabled: true, available: true };
const notConnected = { enabled: true, available: false };
const switchedOff = { enabled: false, available: true };

const base = { enabled: true, models: undefined, failed: false, rememberedReady: false };

describe('the workspace model gate', () => {
  test('opens a workspace with one runnable model among unrunnable ones', () => {
    expect(resolveWorkspaceModelGate({ ...base, models: [notConnected, switchedOff, runnable] })).toBe('open');
  });

  test('blocks a workspace whose models are all unconnected or switched off', () => {
    expect(resolveWorkspaceModelGate({ ...base, models: [notConnected, switchedOff] })).toBe('blocked');
  });

  test('blocks a workspace with an empty model list (Free plan, nothing connected)', () => {
    expect(resolveWorkspaceModelGate({ ...base, models: [] })).toBe('blocked');
  });

  test('the server answer wins over a ready verdict this browser remembered', () => {
    expect(resolveWorkspaceModelGate({ ...base, models: [], rememberedReady: true })).toBe('blocked');
  });

  test('waits for the answer when this browser never saw the workspace ready', () => {
    expect(resolveWorkspaceModelGate(base)).toBe('pending');
  });

  test('opens at once while the answer loads when this browser saw the workspace ready', () => {
    expect(resolveWorkspaceModelGate({ ...base, rememberedReady: true })).toBe('open');
  });

  test('opens when the model list cannot be read, because the server still refuses a model-less session', () => {
    expect(resolveWorkspaceModelGate({ ...base, failed: true })).toBe('open');
  });

  test('never gates when turned off (program agents run without a model)', () => {
    expect(resolveWorkspaceModelGate({ ...base, enabled: false, models: [] })).toBe('open');
  });
});
