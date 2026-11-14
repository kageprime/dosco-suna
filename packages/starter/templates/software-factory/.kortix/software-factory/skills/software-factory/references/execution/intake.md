# Intake: the orchestrator

Trigger `factory-intake`, every 5 minutes, one keyed session (runs never
overlap). Intake reads the store and starts sessions. It never writes code,
never pushes, never merges and never posts to chat.

## Run

1. **Context.** Read factory.json. `store.context`. Resolve the trunk.
2. **Snapshot in code.** `ticket.list` of every open factory ticket and every
   hand-over (contract hard rule 8) into `/tmp/factory/intake/tickets.json`.
   For each, read the comments newer than the newest cycle marker (contract §8)
   in code. Reduce to one JSON line per ticket in
   `/tmp/factory/intake/lines.jsonl`:
   `{id, key, state, priority, created, cycle_start, attempt, claim_session, newest_marker, pr, person_replied}`.
   Read the live worker sessions once: `kortix sessions ls --label factory-worker --json`
   (`running`, `queued`, `provisioning` = running).
3. **Nothing to do** (no line below applies): end with the run line. Write
   nothing. This is the common case.
4. **Duplicates.** Two open tickets with one key: keep the one with a running
   worker, else the newest; post `[factory-intake] duplicate of <kept>` on the
   other and `ticket.cancel` it. Two running workers on one key: touch neither,
   name the key in `dup_keys=`.
5. **Classify** each remaining ticket, first match wins:

| Class | Rule | Action |
|---|---|---|
| waiting | newest marker is `handoff`, `blocked` or `handed back`, and no person commented after it | none (but see the closed-PR and blocked rules) |
| closed PR | waiting on a `handoff` whose pull request is closed without a merge (`gh pr view <n> --json state,mergedAt`) | `[factory-intake] retry · PR <url> closed: <first line of the closing comment>`, then **ready**; the second closed PR of one ticket: `blocked` with `[factory-intake] handed back · closed twice, needs rescoping` |
| blocked, stale | newest marker `blocked`, older than 24 h, no person replied, fewer than 2 such retries | `[factory-intake] retry · blocked over 24 h: pick the reasonable default, state it in the pull request, proceed`, then **ready** |
| triage, owned | state `triage`, factory-filed (hard rule 8a) | `[factory-intake] accepted · triage → ready`, `set_state(ready)`, then **ready** |
| triage, foreign | state `triage`, not factory work | none: a person decides |
| ready | state `ready`, or a new cycle marker (`retry`, `feedback requested`, `reoccurred`, a person's comment) after the last claim | dispatch |
| stalled | state `in_progress`, the claim's session is not running, or the claim is older than 4 h with no pull request and no handoff, or older than 90 min with no comment and no commit on its branch | stop the session when it runs (`kortix sessions stop <id>`), then dispatch |
| in flight | state `in_progress`, the claim's session runs | none |

6. **Dispatch**, highest priority first, then oldest, while running workers
   are fewer than `caps.workers` (a resumed worker takes no new slot). For
   each ticket:
   1. `attempt` = 1 + the claims in the current cycle. Above
      `caps.attempts_per_cycle`: `[factory-intake] handed back · <n> sessions
      ended without a handoff: <ids>`, `set_state(blocked)`, next ticket.
   2. **Rework** (newest cycle marker `[factory-feedback] requested` or
      `[factory-intake] retry` on a ticket with an open pull request):
      resume the claim's session:
      `kortix sessions chat <session_id> --queue --prompt "$(cat /tmp/factory/intake/rework-<id>.md)"`.
      The rework brief: the header with `cycle=rework`, the pull request, the
      feedback items, `Continue on the same branch. Follow references/execution/worker.md, step Rework.`
      Success: `ticket.claim` with the same session and post
      `[factory-intake] resumed · session <id> · rework cycle <n>`. Next ticket.
      Failure (`not found`, an error): continue to 6.3 with the history.
   3. **Model** (contract §10): `models.worker`; `models.worker_hard` for
      attempt 2 or later, rework cycle 3 or later, `source:security`, or a
      ticket that names more than one package.
   4. **Brief** to `/tmp/factory/intake/brief-<id>.md` (contract §9): the
      header, the ticket URL, the store kind, the trunk, the branch name, the
      pull request (when one exists), the feedback items or the closing comment
      (rework and closed PR only, as one list), and
      `Follow references/execution/worker.md.`
   5. **Start**: `kortix sessions new --agent factory --model "$MODEL" --label factory-worker --context factory.role=worker --context factory.ticket=<id> --prompt "$(cat <brief>)" --json`.
      Read `session_id`. A failure: leave the ticket in `ready`, name the error
      in `errors=`, next ticket.
   6. **Claim**: `ticket.claim(id, session_id)`, the comment
      `[factory-intake] claimed · attempt <n> · session <session_id>` with the
      lines `Model: <model> — <reason>` and `Session: <dashboard link>`, and
      `ticket.link` the session.
7. **Rework cap.** A ticket with more than `caps.rework_cycles_before_human`
   `[factory-review] request_changes` comments: `set_state(blocked)` and
   `[factory-intake] handed back · <n> review rejections; a person decides`,
   with the newest items. No more workers.
8. End with the run line.

## Run line

```
factory-intake: read=<n> ready=<n> dispatched=<n> resumed=<n> capped=<n> stalled=<n> in_flight=<n> waiting=<n> handed_back=<n> duplicates=<n> dup_keys=<none|keys> triage=<n> errors=<none|codes>
```

## Never

- Never dispatch a ticket that is not factory work (contract hard rule 8).
- Never start a second worker for a ticket whose worker runs.
- Never stop a running worker to free a slot.
- Never cancel except a duplicate key.
