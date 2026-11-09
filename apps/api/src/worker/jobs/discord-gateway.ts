import { discordGateway } from '../../channels/discord/gateway';
import { runWorkerTick } from '../../shared/audit-scope';
import { leaderTimer } from '../../shared/leader-timer';

/**
 * Leader-only (worker/jobs/index.ts): Discord delivers the bot's messages over
 * one Gateway WebSocket, held by one process. Idle when the Dosco Discord
 * application is not configured. The tick reopens a connection a stop or a
 * fatal close ended; a dropped one reconnects by itself.
 */
const gatewayTimer = leaderTimer(
  async () => {
    await runWorkerTick('discord-gateway', async () => {
      // A fatal close stays closed until the process restarts (gateway.ts `fatal`).
      if (!discordGateway.connected) await discordGateway.start();
    });
    return 60_000;
  },
  { firstDelayMs: 60_000, name: 'discord-gateway' },
);

export function startDiscordGateway(): void {
  void discordGateway.start();
  gatewayTimer.start();
}

/** Saves the session before it closes, so the next leader resumes it (a deploy loses no message). */
export async function stopDiscordGateway(): Promise<void> {
  await gatewayTimer.stop();
  await discordGateway.stop();
}
