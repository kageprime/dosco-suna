'use client';

import { create } from 'zustand';

/** A call: a session of its own on an agent, placed from that agent's page. */
export interface ActiveCall {
  projectId: string;
  sessionId: string;
  /** The agent's name (its slug): the card's mark and name. */
  agent: string;
  /** When it was placed (ms), for "Calling…" before the box answers. */
  placedAt: number;
}

/**
 * The call in progress, one at a time, as there is one microphone. The agent page's Call button places it and the
 * call card (voice-call-card.tsx, in the project shell) runs it wherever the person goes in the project, until it is
 * hung up.
 */
interface VoiceCallStore {
  call: ActiveCall | null;
  /**
   * How many call cards are mounted. A call runs only in a card, and only a host that mounts one (apps/web's project
   * shell) can run it: with none, no control offers a call (`useVoiceCallsEnabled`), so a placed call is never left
   * with nothing to ring it.
   */
  cards: number;
  place: (call: Omit<ActiveCall, 'placedAt'>) => void;
  /** Ends the call (only that session's, when one is named). */
  end: (sessionId?: string) => void;
  /** A call card mounted; the returned function unmounts it. */
  mountCard: () => () => void;
}

export const useVoiceCallStore = create<VoiceCallStore>()((set, get) => ({
  call: null,
  cards: 0,
  place: (call) => set({ call: { ...call, placedAt: Date.now() } }),
  end: (sessionId) => {
    if (!sessionId || get().call?.sessionId === sessionId) set({ call: null });
  },
  mountCard: () => {
    set((s) => ({ cards: s.cards + 1 }));
    return () => set((s) => ({ cards: s.cards - 1 }));
  },
}));
