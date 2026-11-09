import { sweepStaleSlackTurns } from '../../channels/slack/turn';
import { runWorkerTick } from '../../shared/audit-scope';
import { leaderTimer } from '../../shared/leader-timer';

const SWEEP_MS = 5 * 60 * 1000;

// Leader-only (bootstrap.ts): one replica sweeps, not all of them.
const gc = leaderTimer(
  async () => {
    try {
      await runWorkerTick('slack-turn-gc', sweepStaleSlackTurns);
    } catch (err) {
      console.warn('[slack-webhook] gc tick failed', err);
    }
    return SWEEP_MS;
  },
  { firstDelayMs: SWEEP_MS, name: 'slack-turn-gc' },
);

export const startSlackTurnGc = gc.start;
export const stopSlackTurnGc = gc.stop;
