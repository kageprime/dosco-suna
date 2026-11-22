---
title: Continual learning built into My Kortix and the default harness
status: planned, not built; 4 decisions open (decisions.md). Flag `continual_learning`, branch `continual-learning`
owner: Marko (decisions)
updated: 2026-11-17
---

# Continual learning: the agent improves its own harness, proven by its own evals

**The problem.** An agent hits the same failure again and again, and nothing
learns from it. Two product bugs show the cost: `kortix drive put` reported a
failure after every successful upload (exit 132), and `git push` after
`kortix workspaces clone` answered "needs login" in every session. Agents
worked around both silently. Only a benchmark run surfaced them
(PR #12777).

**The mandate (owner, 2026-11-17).** Build it into My Kortix and the default
harness, not as a skill: the agent analyzes the multi-step work it did,
improves itself, maintains its own skill library, and expands its own evals.
The full loop. `kortix-harness-refinement` is "just a skill": an agent must
choose to load it, and its scheduled mode needs a reflection agent and a cron
trigger that no workspace has by default. It is not the answer.

## What exists (dev `ee14eb3eea`)

| Part of the loop | Exists | Where |
|---|---|---|
| Full history of every run | yes | Session log stored by the API (`kortix sessions log`), journaled at every turn end and every 5 s |
| Hooks inside a run | yes | pi `tool_call`, `tool_result` (it can rewrite the output the model sees: `pi-harness.test.ts:1714`), `before_agent_start`, `agent_before_settle`, `agent_settled` |
| A settle-time guard | yes | `harness/pi/extensions/follow-through.ts`: one hidden note on `agent_before_settle`, at most once per run |
| Harness in git | yes | `agents/`, `skills/`, `tools/`, `memory/`, `kortix.yaml`; changes land through `kortix cr` |
| Workspace evals | yes | Suites under `evals:` in `kortix.yaml`, Harbor tasks in the repo, `kortix evals run/compare/judge`, a fresh workspace per trial (`projects/evals/trial-workspace.ts`) |
| Person memory | yes | `kortix_memory` platform tool (`services/tools/platform/kortix_memory.ts`), `/drives/me/Memory` |
| Product feedback | write only | `kortix feedback` → `POST /v1/feedback` → `kortix.feedback` (append-only; kinds bug, idea, friction; 4,000-char text; 8 context ids). Nothing reads the table: no admin page, no job |
| Skill usage data | **no** | kortixd does not record which skill loaded or how the run ended |
| Failure signals | **no** | Errors, retries, corrections and aborts are not recorded as data |
| Something that runs the loop | **no** | Only the opt-in skill |

## The loop

```
every run      OBSERVE   kortixd records signals: tool fail→recover, retries, person corrects,
                         abort, follow-through fired, review rejected, skills loaded → outcome
                         (structured, no content, no model call)
off the user's path:
               SELECT    a worker job picks workspaces whose signals cross a threshold
               ANALYZE   the built-in learner agent reads the session logs and groups
                         failures across sessions by root cause
               PROPOSE   one harness change per cause, on a branch: skill, memory, prompt or
                         tool; create, update or delete
               TEST      it writes an eval task that reproduces the failure (synthetic),
                         proves it (oracle = 1, nop = 0), runs main against the branch with
                         3+ attempts, plus the workspace regression suite
               DECIDE    keep only with a margin (0/3 → 3/3, 1/3 → 3/3) and no regression;
                         a failed idea goes into the ledger so it is not tried again
               SHIP      by policy: merge, or a change request; one line to the person:
                         "Learned X: 0/3 → 3/3"
periodically:  MAINTAIN  skills: delete unused, merge near-duplicates, hold a token budget;
                         evals: always-passing tasks move to regression, flaky tasks are
                         fixed or deleted
opt-in:        PLATFORM  general patterns and their tasks come to Kortix: our benchmark and
                         the managed skills improve for every workspace
```

### New pieces

1. **kortixd `learning` extension.** Observes signals and skill usage on every
   run. A failure is a tool error, a non-zero exit, or a `kortix` CLI error;
   its signature is the command without arguments plus the error class. A
   recovery is a later success of the same command, or the same goal reached
   another way.
2. **API table and worker job.** Signals, plus a learning ledger: what was
   tried, the eval result, the decision. The job follows the worker rules in
   `AGENTS.md`: one file in `worker/jobs/`.
3. **The learner, a built-in agent** in the default harness, like My Kortix.
   Not workspace config and not a skill. Three subagents: analyzer, eval
   writer, fixer. The eval writer never sees the fix.
4. **The eval gate**, on the existing runner with a fresh workspace per trial.
5. **"What I learned"** in the web app: each change, its proof, an undo.
6. **Delete `kortix-harness-refinement`** in the same branch. Its scheduled
   curation idea can survive as a short section of `kortix-memory`.

### Lessons: delivery at the moment of need (an earlier, smaller variant)

A lesson is a symptom and a fix, keyed by a failure signature. Captured on
`agent_before_settle` when a run failed and then recovered (one hidden note,
like follow-through), stored by a `kortix_lessons` platform tool in an API
table (no git, no change request), and delivered through `tool_result`: when
a command matches a stored signature, the result gets one line, "Known in
this workspace: <fix>". No prompt growth, no skill to load. Every delivery
counts a hit; a lesson whose fix keeps failing is demoted. A lesson Kortix
approves can reach every workspace as data from the API: a hotfix channel
for agent behavior without an image rebuild. When the product fix ships, the
lesson is marked fixed in that version and stops.

The learner loop can use lessons as its cheapest kind of change.

### Self-report as one input, never the only one

Extend `kortix feedback` with a `failure` kind and fields `--signature`,
`--tried`, `--fix`, `--scope workspace|kortix`. The agent writes the generic
form; the server scrubs emails and ids. A nightly job groups reports by
signature: a product bug becomes a Linear issue, a harness gap becomes a
managed skill edit, and every group becomes a synthetic task in
`evals/my-kortix`. Self-report cannot catch a failure the agent does not
notice (a model once claimed a `.docx` that was not in Drive), so the kortixd
signals stay the primary source.

## Hard parts

1. **Goodhart.** The learner writes the test and the fix. Guards: the eval
   writer never sees the fix; oracle and nop are mandatory; the regression
   suite is not the learner's to edit; a judge checks that the task
   reproduces the real failure.
2. **Poisoning.** The learner reads logs that may hold injected text. It
   writes only harness paths on a branch, never secrets, connectors or
   members. A change to an agent's permissions never merges without a
   person. A lesson is shown to the model as an observation to check, never
   as an instruction. Nothing crosses workspaces without Kortix review.
3. **Cost.** A proof costs (main + branch) × 3 attempts × tasks. Flash-model
   trials cost about $0.04 in the 2026-11-16 benchmark runs. Needs a weekly
   cap per workspace, paid from workspace credits.
4. **Noise.** 3 attempts is low power. Require a margin.
5. **Bloat.** A token budget for the skill library. Delete is a normal
   outcome. SkillsBench (arXiv 2602.12670): curated skills +16.2 points,
   self-written skills about 0. Unfiltered self-written knowledge does not
   help; the eval gate is the filter.
6. **Privacy.** By default nothing leaves the workspace except content-free
   signal counts. Lesson text and eval tasks reach Kortix only from
   workspaces that opt in.

## Proof

1. A learning benchmark: Harbor tasks with seeded failure histories (a wrong
   skill, a CLI quirk, a step people keep correcting). Pass = the learner
   ships a proven fix and changes nothing else.
2. On dev, end to end: seed a workspace, let sessions fail, run the learner;
   it ships a task plus a fix with proof; the next real session succeeds.
3. No regression: the My Kortix capability benchmark (`evals/my-kortix`)
   stays at 26/34 or better on both flash models.
4. Lessons only: session A records a lesson on a seeded failing command;
   session B in the same workspace gets the line and needs fewer tool calls.
   A benchmark version needs a runner step that opens a second session.

## Phases

1. **Observe:** signals, skill usage, ledger table, read-only. First output:
   real failure patterns on dev.
2. **Learn:** learner, eval gate, change requests only. Delete the
   harness-refinement skill.
3. **Maintain and ship:** library and eval maintenance, the merge policy,
   the "What I learned" UI (design pass with Jay).
4. **Platform tier:** opt-in, feeding `evals/my-kortix` and the managed skills.

## Related

- [`agent-benchmark-expansion/`](../agent-benchmark-expansion/README.md): the
  external research and the task backlog this loop feeds.
- `.agents/skills/evals/SKILL.md`: the eval system and the My Kortix benchmark.
