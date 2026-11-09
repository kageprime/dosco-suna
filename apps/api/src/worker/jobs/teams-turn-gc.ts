import { sweepStaleTeamsTurns } from '../../channels/teams/turn';
import { runWorkerTick } from '../../shared/audit-scope';
import { leaderTimer } from '../../shared/leader-timer';

const SWEEP_MS = 5 * 60 * 1000;

// Leader-only (bootstrap.ts): one replica sweeps, not all of them.
const gc = leaderTimer(
  async () => {
    try {
      await runWorkerTick('teams-turn-gc', sweepStaleTeamsTurns);
    } catch (err) {
      console.warn('[teams-webhook] gc tick failed', err);
    }
    return SWEEP_MS;
  },
  { firstDelayMs: SWEEP_MS, name: 'teams-turn-gc' },
);

export const startTeamsTurnGc = gc.start;
export const stopTeamsTurnGc = gc.stop;
