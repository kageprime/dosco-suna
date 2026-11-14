/**
 * Turn segmentation.
 *
 * A burst is a maximal run of non-text parts. Only an assistant TEXT part
 * closes a burst. This replaces the old tool-identity grouping, which shattered
 * an interleaved run of read → web_search → read into three sibling cards.
 *
 * No React import. Every rule here is unit-tested in segment-turn.test.ts.
 */
import type { Part, TextPart, ToolPart } from '../../runtime/client';
import { isTextPart, isToolPart } from '../parts';
import { toolKind } from '../tool-kind';
import {
  isInvisibleActivityPart,
  isNoGroupActivityTool,
  isStandaloneActivityTool,
} from './session-activity-groups';
import { partStartsConnectorSignIn } from './sign-in-call';

export type Segment =
  | { kind: 'burst'; parts: Part[] }
  | { kind: 'text'; part: TextPart }
  | { kind: 'standalone'; part: ToolPart };

export interface SegmentTurnOptions {
  /** callIDs with a pending permission or an active question — always standalone. */
  standaloneCallIds?: ReadonlySet<string>;
}

/**
 * A call a codemode script in `parts` made (pi's nested id `<script callID>/<n>`) that its
 * script row already lists, so it draws nowhere else. A deliverable, a sub-agent (its card
 * opens the child session), a call waiting on the person and a connector sign-in (its
 * Connect card draws only under its own row) keep their own card.
 */
function scriptChildIsListed(
  part: ToolPart,
  scripts: ReadonlySet<string>,
  opts: SegmentTurnOptions,
): boolean {
  const slash = part.callID.lastIndexOf('/');
  if (slash < 0 || !scripts.has(part.callID.slice(0, slash))) return false;
  return (
    !isNoGroupActivityTool(part.tool) &&
    toolKind(part.tool) !== 'task' &&
    !opts.standaloneCallIds?.has(part.callID) &&
    !partStartsConnectorSignIn(part)
  );
}

export function segmentTurn(parts: ReadonlyArray<Part>, opts: SegmentTurnOptions = {}): Segment[] {
  const segments: Segment[] = [];
  let pending: Part[] = [];
  const scripts = new Set(
    parts
      .filter(isToolPart)
      .filter((p) => toolKind(p.tool) === 'script')
      .map((p) => p.callID),
  );

  const flush = () => {
    if (pending.length > 0) {
      segments.push({ kind: 'burst', parts: pending });
      pending = [];
    }
  };

  for (const part of parts) {
    // Snapshot/patch bookkeeping and blank text render nothing. They must not
    // split a run of groupable tool calls — otherwise consecutive shells
    // fragment into inconsistent singles instead of one "Ran N commands" group.
    if (isInvisibleActivityPart(part)) continue;

    if (isTextPart(part)) {
      flush();
      segments.push({ kind: 'text', part });
      continue;
    }

    if (isToolPart(part)) {
      if (scriptChildIsListed(part, scripts, opts)) continue;
      const standalone =
        isStandaloneActivityTool(part.tool) ||
        !!opts.standaloneCallIds?.has(part.callID) ||
        partStartsConnectorSignIn(part);
      if (standalone) {
        flush();
        segments.push({ kind: 'standalone', part });
        continue;
      }
    }

    pending.push(part);
  }

  flush();
  return segments;
}
