import { config } from '../../config';
import { countProvisioningProjectSessions } from '../lib/sessions';

/**
 * Trigger fires only (`queuePolicy: 'on_backpressure'` in `lib/trigger-fire.ts`).
 *
 * While the project has this many sessions starting, a fire is written as a
 * queued `create_session` command instead of running inline. The queued row is
 * due at once and the drain does not re-check this count, so it never holds a
 * fire until a slot frees. What it bounds is a burst: queued creates run
 * through the drain, at most `MAX_CONCURRENT_DRAINS` × 10 at once per API
 * process (`replica/session-lifecycle.ts`), where a webhook storm would
 * otherwise create every session at once.
 *
 * Chat channels (Slack, Teams, Telegram, Email, Discord) create inline, like
 * the web app: one person's message is not a burst. On 2026-11-11 four rows
 * stuck in `provisioning` held one project at the limit for 3 days, and every
 * Slack mention there answered "I've queued your task behind the sessions
 * already starting up", then started 1 s later.
 */
export function triggerBackpressureLimit() {
  const configured = Number((config as any).KORTIX_TRIGGER_MAX_PROVISIONING_SESSIONS_PER_PROJECT);
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : 3;
}

export async function sessionBackpressureState(projectId: string) {
  const provisioning = await countProvisioningProjectSessions(projectId);
  const projectProvisioningLimit = triggerBackpressureLimit();
  const shouldQueue = provisioning >= projectProvisioningLimit;
  return {
    shouldQueue,
    provisioning,
    projectProvisioningLimit,
    reason: shouldQueue ? 'project provisioning backpressure' : null,
  };
}
