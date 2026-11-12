import { describe, expect, test } from 'bun:test';

import { useVoiceCallStore } from './voice-call-store';

// A call runs only in a mounted call card, so the call controls read `cards`
// (`useVoiceCallsEnabled`): a host without a card offers no call.
describe('voice call store: mounted call cards', () => {
  test('each mount counts once and its own unmount takes it back', () => {
    const start = useVoiceCallStore.getState().cards;
    const unmountA = useVoiceCallStore.getState().mountCard();
    const unmountB = useVoiceCallStore.getState().mountCard();
    expect(useVoiceCallStore.getState().cards).toBe(start + 2);
    unmountA();
    expect(useVoiceCallStore.getState().cards).toBe(start + 1);
    unmountB();
    expect(useVoiceCallStore.getState().cards).toBe(start);
  });

  test('ending a call names its session, or ends whichever runs', () => {
    const { place, end } = useVoiceCallStore.getState();
    place({ projectId: 'p', sessionId: 's1', agent: 'kortix' });
    end('s2');
    expect(useVoiceCallStore.getState().call?.sessionId).toBe('s1');
    end('s1');
    expect(useVoiceCallStore.getState().call).toBeNull();
    place({ projectId: 'p', sessionId: 's3', agent: 'kortix' });
    end();
    expect(useVoiceCallStore.getState().call).toBeNull();
  });
});
