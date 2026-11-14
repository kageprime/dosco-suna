/**
 * A call that started a connector sign-in the person finishes on its Connect
 * card. Like a question or a setup link in text, it waits on the person: it
 * stands alone (`segment-turn.ts`), stays out of the settled-turn fold
 * (`work-split.ts`) and out of an agent's run (`session-log/turns/agent-runs.ts`).
 * A call that failed started nothing: an error, a shell command that exited
 * non-zero, or a `kortix_connectors` result with `ok: false`
 * (`toolCallConnectorSignIns`). Internal: not exported from the segments barrel.
 */
import type { Part } from '../../runtime/client';
import type { ToolCallBlock } from '../../session-log/types';
import { isToolPart } from '../parts';
import { toolCallConnectorSignIns } from '../tools/connector-sign-in';

/** A session-log tool call that started a connector sign-in. */
export function callStartsConnectorSignIn(call: ToolCallBlock): boolean {
  return toolCallConnectorSignIns(call).length > 0;
}

/**
 * The same rule for a v1 tool part, read as the block it came from: its
 * output is the result text, and its exit code rides `state.metadata.exit`.
 */
export function partStartsConnectorSignIn(part: Part): boolean {
  if (!isToolPart(part)) return false;
  const state = part.state as { status?: string; input?: unknown; output?: unknown; metadata?: { exit?: unknown } };
  const status = state.status === 'error' ? 'error' : state.status === 'completed' ? 'complete' : 'running';
  const exit = state.metadata?.exit;
  return (
    toolCallConnectorSignIns({
      name: part.tool,
      input: state.input,
      status,
      result:
        status === 'complete'
          ? {
              content: [{ type: 'text', text: typeof state.output === 'string' ? state.output : '' }],
              is_error: false,
              ...(typeof exit === 'number' ? { exit_code: exit } : {}),
            }
          : undefined,
    }).length > 0
  );
}
