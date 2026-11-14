/**
 * The agent runs of a transcript (`sessionLogAgentRuns`, KRTX-4732), as row props: a person's
 * agents report back as one unit: the reports and work of a run fold into one row on its last
 * turn, and every answer stays in view under it. Port of apps/web `session/thread/agent-run-props.ts`.
 *
 * A stream delta remakes the turn list. A row whose run did not change keeps its props object,
 * so its memoized `SessionTurn` still bails out. When no row changed, the layout object itself
 * is kept: the list's `renderItem` depends on it, and a new one re-renders every mounted cell.
 */
import { sessionLogAgentRunLabel, sessionLogAgentRuns, type SessionLogTurn } from '@kortix/sdk';
import { useMemo, useState } from 'react';

/** What one transcript row receives from its agent run. */
export interface AgentRunRowProps {
  /** The run's row: "Worked for 5m · 3 agents", live "Working · 2 of 3 agents reported". */
  runLabel?: string;
  /** The run's other turns, in order: the list draws no row for them. */
  runTurns?: readonly SessionLogTurn[];
  /** Every agent this turn started has reported: its agent rows fold too. */
  foldStartedWork?: boolean;
}

export interface AgentRunLayout {
  /** The turns the list draws no row for: they fold into their run's anchor. */
  absorbed: ReadonlySet<string>;
  propsOf: (turnId: string) => AgentRunRowProps;
}

const NONE: AgentRunRowProps = Object.freeze({});
const EMPTY: AgentRunLayout = { absorbed: new Set(), propsOf: () => NONE };

const sameTurns = (a: readonly SessionLogTurn[] | undefined, b: readonly SessionLogTurn[] | undefined) =>
  a === b || (!!a && !!b && a.length === b.length && a.every((turn, i) => turn === b[i]));

const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>) => a.size === b.size && [...a].every((id) => b.has(id));

export function useAgentRunLayout(turns: readonly SessionLogTurn[]): AgentRunLayout {
  // The props each row got last time, and the layout they made. A cache, not state: writing it never renders.
  const [previous] = useState(() => new Map<string, AgentRunRowProps>());
  const [last] = useState<{ layout: AgentRunLayout }>(() => ({ layout: EMPTY }));
  return useMemo(() => {
    const layout = sessionLogAgentRuns(turns);
    if (layout.runs.size === 0 && layout.settledLaunches.size === 0) {
      previous.clear();
      last.layout = EMPTY;
      return EMPTY;
    }
    const kept = last.layout;
    let same = kept !== EMPTY && previous.size > 0 && sameSet(kept.absorbed, layout.absorbed);
    const byId = new Map(turns.map((turn) => [turn.id, turn] as const));
    const next = new Map<string, AgentRunRowProps>();
    for (const id of new Set([...layout.runs.keys(), ...layout.settledLaunches])) {
      const run = layout.runs.get(id);
      const fresh: AgentRunRowProps = {
        ...(run
          ? { runLabel: sessionLogAgentRunLabel(run), runTurns: run.turns.slice(0, -1).map((turnId) => byId.get(turnId)!) }
          : {}),
        ...(layout.settledLaunches.has(id) ? { foldStartedWork: true } : {}),
      };
      const old = previous.get(id);
      const unchanged =
        old &&
        old.runLabel === fresh.runLabel &&
        !!old.foldStartedWork === !!fresh.foldStartedWork &&
        sameTurns(old.runTurns, fresh.runTurns);
      next.set(id, unchanged ? old : fresh);
      if (!unchanged) same = false;
    }
    if (same && next.size === previous.size) return kept;
    previous.clear();
    for (const [id, props] of next) previous.set(id, props);
    last.layout = { absorbed: layout.absorbed, propsOf: (turnId: string) => next.get(turnId) ?? NONE };
    return last.layout;
  }, [turns, previous, last]);
}
