/**
 * Internal: not exported from the package. Turn segmentation drops an agent
 * start the model retried, so the reader sees each colleague once.
 */
import { toolKind } from '../tool-kind';
import type { ActivityPartLike } from './session-activity-groups';

/** The identities of an agent call: its name, its inline spec's role, its task. */
function agentCallKeys(part: ActivityPartLike): string[] {
  const input = part.state?.input ?? {};
  const spec = typeof input.agent === 'object' && input.agent !== null ? (input.agent as { description?: unknown }).description : undefined;
  return [input.name, spec, input.description]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map((value) => value.trim().replace(/^@/, '').toLowerCase());
}

/**
 * The agent calls that failed and that a later call in the same turn started
 * again as the same colleague (same name, inline role or task). The model reads
 * the error and retries; the reader sees the colleague once, as the retry.
 * A failure with no later success stays, and so does one after a success.
 */
export function retriedAgentFailures<P extends ActivityPartLike & { callID?: string }>(parts: readonly P[]): Set<string> {
  const retried = new Set<string>();
  const later = new Set<string>();
  for (let index = parts.length - 1; index >= 0; index--) {
    const part = parts[index]!;
    if (part.type !== 'tool' || !part.tool || toolKind(part.tool) !== 'task') continue;
    const keys = agentCallKeys(part);
    if (part.state?.status === 'error') {
      if (part.callID && keys.some((key) => later.has(key))) retried.add(part.callID);
      continue;
    }
    for (const key of keys) later.add(key);
  }
  return retried;
}
