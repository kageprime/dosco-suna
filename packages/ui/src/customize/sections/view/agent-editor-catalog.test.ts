import { describe, expect, test } from 'bun:test';

import { agentPromotes, AGENT_MODE_LABEL, AGENT_MODES } from './agent-editor-catalog';

// KRTX-4810: an agent My Kortix creates is a subagent hidden from the pickers.
// The properties panel's "Who can start it" select is the promote control —
// promoting out of subagent must also clear "Show in pickers", or the promoted
// agent never lands in the pickers and the promotion looks broken.
describe('agentPromotes', () => {
  test('a subagent promoted to primary or all clears "Show in pickers"', () => {
    expect(agentPromotes('subagent', 'primary')).toBe(true);
    expect(agentPromotes('subagent', 'all')).toBe(true);
    // The workspace default reads as primary: promoting to it lands in the pickers too.
    expect(agentPromotes('subagent', undefined)).toBe(true);
  });

  test('a pick inside subagent, or any change from a non-subagent mode, does not', () => {
    expect(agentPromotes('subagent', 'subagent')).toBe(false);
    expect(agentPromotes('primary', 'subagent')).toBe(false);
    expect(agentPromotes('all', 'primary')).toBe(false);
    expect(agentPromotes(undefined, 'primary')).toBe(false);
    expect(agentPromotes(undefined, undefined)).toBe(false);
  });

  test('the role labels the card badge shows match the properties panel select', () => {
    for (const mode of AGENT_MODES) expect(AGENT_MODE_LABEL[mode]).toBeTruthy();
  });
});
