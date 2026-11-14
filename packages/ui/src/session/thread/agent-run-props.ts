'use client';

import { sessionLogAgentRuns, type SessionLogAgentRun, type SessionLogTurn } from '@kortix/sdk';
import { useMemo, useState } from 'react';

/** What one transcript row receives from its agent run (KRTX-4732). */
export interface AgentRunRowProps {
  agentRun?: SessionLogAgentRun;
  runTurns?: readonly SessionLogTurn[];
  foldStartedWork?: boolean;
}

export interface AgentRunLayout {
  /** The turns the transcript draws no row for: they fold into their run's anchor. */
  absorbed: ReadonlySet<string>;
  /** A row's run props; the same object while nothing about the run changed. */
  propsOf: (turnId: string) => AgentRunRowProps;
}

const NONE: AgentRunRowProps = Object.freeze({});
const EMPTY: AgentRunLayout = { absorbed: new Set(), propsOf: () => NONE };

const sameRun = (a: SessionLogAgentRun, b: SessionLogAgentRun) =>
  a.anchor === b.anchor &&
  a.agents === b.agents &&
  a.started === b.started &&
  a.reported === b.reported &&
  a.durationMs === b.durationMs &&
  a.live === b.live &&
  a.stopped === b.stopped &&
  a.turns.length === b.turns.length &&
  a.turns.every((id, i) => id === b.turns[i]);

const sameTurns = (a: readonly SessionLogTurn[] | undefined, b: readonly SessionLogTurn[] | undefined) =>
  a === b || (!!a && !!b && a.length === b.length && a.every((turn, i) => turn === b[i]));

/**
 * The agent runs of a transcript (`sessionLogAgentRuns`), as row props. A stream delta remakes
 * the turn list; a row whose run did not change keeps its props object, so its memoized row
 * still bails out. `disabled` (a messages-only thread): no runs.
 */
export function useAgentRunLayout(turns: readonly SessionLogTurn[], disabled: boolean): AgentRunLayout {
  // The props each row got last time. A cache, not state: writing it never renders.
  const [previous] = useState(() => new Map<string, AgentRunRowProps>());
  return useMemo(() => {
    if (disabled) return EMPTY;
    const layout = sessionLogAgentRuns(turns);
    if (layout.runs.size === 0 && layout.settledLaunches.size === 0) {
      previous.clear();
      return EMPTY;
    }
    const byId = new Map(turns.map((turn) => [turn.id, turn] as const));
    const next = new Map<string, AgentRunRowProps>();
    const ids = new Set([...layout.runs.keys(), ...layout.settledLaunches]);
    for (const id of ids) {
      const run = layout.runs.get(id);
      const runTurns = run?.turns.slice(0, -1).map((turnId) => byId.get(turnId)!);
      const fresh: AgentRunRowProps = {
        ...(run ? { agentRun: run, runTurns } : {}),
        ...(layout.settledLaunches.has(id) ? { foldStartedWork: true } : {}),
      };
      const old = previous.get(id);
      const unchanged =
        old &&
        !!old.foldStartedWork === !!fresh.foldStartedWork &&
        (old.agentRun && fresh.agentRun ? sameRun(old.agentRun, fresh.agentRun) : old.agentRun === fresh.agentRun) &&
        sameTurns(old.runTurns, fresh.runTurns);
      next.set(id, unchanged ? old : fresh);
    }
    previous.clear();
    for (const [id, props] of next) previous.set(id, props);
    return { absorbed: layout.absorbed, propsOf: (turnId: string) => next.get(turnId) ?? NONE };
  }, [turns, disabled, previous]);
}
