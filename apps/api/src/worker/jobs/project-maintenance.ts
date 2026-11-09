import { maintenanceIntervalMs, runProjectMaintenance } from '../../projects/maintenance';
import { runWorkerTick } from '../../shared/audit-scope';
import { inPlatinumBackgroundLane } from '../../shared/platinum-write-lane';
import { leaderTimer } from '../../shared/leader-timer';

let timer: ReturnType<typeof leaderTimer> | null = null;

export function startProjectMaintenance(): void {
  if (process.env.KORTIX_PROJECT_MAINTENANCE_ENABLED === 'false') return;
  if (timer) return;
  const interval = maintenanceIntervalMs();
  timer = leaderTimer(
    async () => {
      // The sweeps' Platinum writes are paced so a session start keeps its share of the org budget.
      try {
        await runWorkerTick('project-maintenance', () => inPlatinumBackgroundLane(runProjectMaintenance));
      } catch (err) {
        console.error('[project-maintenance] run failed:', err);
      }
      return interval;
    },
    { firstDelayMs: interval, name: 'project-maintenance' },
  );
  timer.start();
}

export async function stopProjectMaintenance(): Promise<void> {
  const stopped = timer;
  timer = null;
  await stopped?.stop();
}
