---
name: kortix-evals
description: "Eval-driven development for agents: write tasks with a verifier that scores them, run an agent on them, read the score, change the agent, run again, and keep only changes that score better. Tasks use the Harbor format (instruction.md, task.toml, tests/test.sh writes the reward), suites live under `evals:` in kortix.yaml, `kortix evals` runs and compares them, and `kortix evals judge` scores open-ended work with a model. Load before you build or change an agent, its prompt, skills, tools or model; when someone asks whether an agent got better or worse; when asked to benchmark, eval, evalmaxx or benchmaxx; to run Terminal-Bench or another Harbor dataset; or to write an eval task or a grader."
metadata:
  kortix-feature-flag: evals
---

<skill name="kortix-evals">

<overview>
An eval says whether an agent does the job, with a number. Build agents
against evals the way you build code against tests: write the tasks first,
measure, change one thing, measure again. A change that does not raise the
score, or that lowers it on any task, does not ship.

Kortix runs the **Harbor task format** unchanged
(https://harborframework.com/docs/tasks). Names:

| Term | Meaning |
| --- | --- |
| task | a folder: `instruction.md`, `task.toml`, `environment/`, `tests/test.sh`, optional `solution/solve.sh` |
| verifier | `tests/test.sh`. It runs after the agent stops and writes the reward |
| reward | `/logs/verifier/reward.txt` (one number) or `/logs/verifier/reward.json` (named numbers, 0 to 1) |
| trial | one agent's attempt at one task, in its own session and sandbox |
| job | tasks × agents × attempts, run at one commit |
| suite | a job config under `evals:` in kortix.yaml |
| pass | every reward of a trial is 1 or more |
| pass@1 | the share of tasks passed on the first attempt: the headline score |

The tests reach the sandbox only after the agent stops, so the agent never
sees them. Results are in Files under `/Evals/<job>/`, in Harbor's `jobs/`
layout, and in the web app under Customize → Evals: Overview (the
leaderboard), Datasets, Tasks and Jobs. Jobs → select two → Compare shows the
same table `kortix evals compare` prints.
</overview>

<loop>
The eval loop. Follow it for any change to an agent.

1. **Write the tasks.** Each task is one thing the agent must do, with a
   verifier that checks the end state, not the transcript wording. Start
   with 5 to 20 tasks that cover the real uses, the hard cases and the ways
   the agent fails today. Add a task for every bug you fix.
2. **Prove each task.** Run `oracle` (it runs `solution/solve.sh`) and `nop`
   (it does nothing). Every task must score 1 with oracle and 0 with nop.
   A task that passes with nop is broken: its verifier checks nothing.
   ```bash
   kortix evals run smoke --agent oracle --agent nop --wait
   ```
3. **Baseline.** Run the agent as it is, with 3 attempts or more: one
   attempt hides luck. Note the job id.
   ```bash
   kortix evals run <suite> --attempts 3 --wait
   ```
4. **Read the failures.** `kortix evals show <job>` lists every trial.
   `kortix evals trial <job> <trial> --file verifier/test-stdout.txt` shows
   why a trial failed; the trial's session holds what the agent did. Find
   the cause, not the symptom.
5. **Change one thing.** The prompt, a skill, a tool, the model. One change
   per run, or you cannot tell which change moved the score.
6. **Run again and compare, task by task.**
   ```bash
   kortix evals run <suite> --attempts 3 --wait
   kortix evals compare <baseline_job> <new_job>
   ```
   Keep the change only when pass@1 rises and no task got worse. A task that
   got worse is a regression even when the total rose.
7. **Commit the change with its score** in the commit message: the suite,
   both job ids, pass@1 before and after.

Do not tune the agent to the tasks' wording, and never read `tests/` into
the agent's prompt or skills: that raises the score and not the agent.
Keep a few tasks out of the loop (a second suite) and check them at the
end; a change that helps only the tasks you looked at is overfitting.
</loop>

<tasks>
Write a task:

```bash
kortix evals init            # writes evals/tasks/hello-world and prints the suite
```

```text
evals/tasks/<task>/
├── instruction.md        the prompt. Name absolute paths and the exact output format
├── task.toml             [agent] timeout_sec, [verifier] timeout_sec, [environment]
├── environment/          optional: a Dockerfile, or [environment] docker_image
├── tests/test.sh         the verifier: check the end state, write the reward
└── solution/solve.sh     the reference solution (oracle runs it)
```

```toml
# task.toml
[agent]
timeout_sec = 600.0

[verifier]
timeout_sec = 120.0
environment_mode = "shared"     # Kortix runs the verifier in the trial's sandbox

[verifier.env]
EXPECTED_ROWS = "42"

[environment]
docker_image = "python:3.12-slim-bookworm"   # optional: the task's own image (Debian family)
```

A task without `docker_image` or a Dockerfile runs in the agent's own
sandbox. A task with one gets a sandbox template built from it once; later
trials reuse it.

Kortix does not run yet: multi-step tasks (`[[steps]]`), docker-compose
environments, a separate verifier environment, Windows, GPUs. `kortix evals
tasks <suite>` names each unsupported task and why.
</tasks>

<graders>
`tests/test.sh` is any program that writes a reward. Pick the grader by what
"done" means:

| Kind | How | Use for |
| --- | --- | --- |
| deterministic | run the code, query the file, compare output | coding, data, files, anything with one right end state |
| reference | compare with an expected answer kept in `tests/` | extraction, numbers, "the answer is X" |
| model judge | `kortix evals judge` scores against named criteria | writing, research, summaries, tone |
| agent judge | a Kortix session inspects the result, then writes the score | open work that needs investigation to judge |

Deterministic, with partial credit:

```bash
#!/bin/bash
mkdir -p /logs/verifier
passed=0; total=3
[ "$(printf '1 2 3' | bash /app/sum.sh)" = 6 ] && passed=$((passed+1))
[ "$(printf '' | bash /app/sum.sh)" = 0 ] && passed=$((passed+1))
[ "$(printf -- '-1 1' | bash /app/sum.sh)" = 0 ] && passed=$((passed+1))
echo "{\"correctness\": $(awk "BEGIN{print $passed/$total}")}" > /logs/verifier/reward.json
```

Model judge, combined with a code check. The judge merges its scores into
`reward.json`, and its reasoning lands in the trial's `test-stdout.txt`:

```bash
#!/bin/bash
mkdir -p /logs/verifier
exists=0; [ -s /workspace/report.md ] && exists=1
echo "{\"exists\": $exists}" > /logs/verifier/reward.json
kortix evals judge \
  --criterion accurate="Every number in the report matches /tests/facts.json." \
  --criterion complete="The report covers revenue, churn and the three largest accounts." \
  --criterion concise="The report is under 400 words." \
  --input /workspace/report.md --input /tests/facts.json
```

Pin the judge model (`--model <id>`, or `KORTIX_EVAL_JUDGE_MODEL` in
`[verifier.env]`): scores from two judge models do not compare. Judge one
property per criterion, say what earns 1.0, and run 3 attempts or more.

Every trial of a job runs in the same workspace. A check of workspace state
(triggers, invites, connectors, members) sees what other trials did, before and
during this one. Check what this trial's session did instead:
`kortix sessions log "$KORTIX_SESSION_ID" --json`, and read only the inputs of
its tool calls, never their output (help text names commands too). Remove what
a trial created in the verifier, after grading.

Never write a 0 when the judge fails (`|| echo '{"accurate": 0}' > …`). A
missing CLI or a model outage then reads as a worse agent. Let the verifier
fail instead: `… --input <file> || { rm -f /logs/verifier/reward.json; exit 1; }`.
With no reward the trial counts as an error, not as a score. A judge also
grades from what it knows: when a fact can change (a version, a price, a
date), tell it not to rule on whether the fact is current.

Agent judge: start a session of a judge agent from the verifier with `kortix
sessions`, give it the result and the rubric, and have it write the scores to
a file the verifier copies into `reward.json`.

Rules for every grader:
- Check the end state the instruction asks for, at the path it names.
- Never let the reward depend on the agent's own claim ("I did it").
- Write the reward on every path, including failure: no reward file is an
  error (`RewardFileNotFoundError`), not a 0.
- Print what you checked: the output is the only explanation of a score.
</graders>

<suites>
```yaml
# kortix.yaml
evals:
  smoke:                         # proves the tasks: oracle 1, nop 0
    tasks: evals/tasks
    agents: [oracle, nop]
  worker:
    tasks: evals/tasks
    agents:
      - name: worker
      - name: worker
        model_name: <provider/model>   # the same agent on another model
    n_attempts: 3
    n_concurrent_trials: 4
  my-kortix:                      # a built-in dataset Kortix ships
    datasets: [{ name: kortix/my-kortix }]
    agents: [mykortix]
  terminal-bench:
    datasets:
      - name: terminal-bench          # a Harbor registry dataset
        version: "2.0"
        n_tasks: 10
    agents: [worker]
  nightly:
    config: evals/nightly.yaml        # a Harbor job config file, read as is
```

The fields are Harbor's job config fields: `tasks`, `datasets`, `agents`
(`name`, `model_name`, `override_timeout_sec`), `n_attempts`,
`n_concurrent_trials`, `timeout_multiplier`, `retry.max_retries`,
`override_error_policy`, `metrics` (`mean`, `sum`, `min`, `max`). An agent is
an agent of kortix.yaml, `oracle` or `nop`. `kortix evals datasets` lists the
Harbor registry.
</suites>

<scoring>
- A reward counts unless an error marks it invalid. Errors follow Harbor's
  policy: an agent timeout or crash is graded and counts; a sandbox failure
  is retried and never scored; a model API error is graded but does not
  count; a verifier that writes no reward is an error.
- The default metric is the mean per reward key; a trial without a key
  counts 0 for it.
- pass@k is Harbor's unbiased estimate, `1 − C(n−c, k) / C(n, k)` per task
  (n attempts, c passed), averaged over tasks. It exists only when every
  reward is one key of 0 or 1; a graded task reports its mean instead.
  Report pass@1; pass@3 shows what more attempts would buy.
- Each score carries a 95% interval (`± x`). Two scores whose intervals
  overlap are not a clear change: add tasks or attempts before you call it.
- A job's numbers are only comparable with a job of the same suite, at a
  commit whose tasks did not change, with the same judge model.
- Two jobs compare only from the same starting state. A task that changes
  the workspace (a connector, a trigger, an invite, a feature flag) leaves the
  next job less to do. Run each variant, and each model, in its own fresh
  workspace, or undo the changes between runs.
- A mixed result (one model better, one worse, or a gain inside the ± interval)
  is not a decision: run the same job again before you keep or drop the change.
  A rule the change targets is measured on its own criterion, across every
  attempt, not only on the task's pass/fail.
</scoring>

<commands>
| Command | Does |
| --- | --- |
| `kortix evals init` | write a first task and print a suite |
| `kortix evals suites` | the suites of kortix.yaml, each with its last score |
| `kortix evals tasks <suite>` | the tasks a suite selects, and what cannot run |
| `kortix evals datasets` | the built-in datasets (`kortix/…`) and the Harbor registry |
| `kortix evals tasks --dataset <name>[@<version>]` | the tasks of a dataset |
| `kortix evals run <suite> [--agent <name>[@<model>]] [--attempts <n>] [--task <glob>] [--wait]` | start a job |
| `kortix evals run --dataset <name>[@<version>] --agent <name> [--task <glob>]` | start a job on a dataset, without a suite |
| `kortix evals jobs` / `show <job>` / `watch <job>` | read jobs and scores |
| `kortix evals trial <job> <trial> [--file <path>]` | one trial and its files |
| `kortix evals compare <job_a> <job_b>` | task by task: better, worse, same |
| `kortix evals rerun <job> --failed` | run the failed trials again |
| `kortix evals cancel <job>` / `rm <job>` | stop or delete a job |
| `kortix evals judge --criterion <name>="<…>" --input <file>` | score open-ended work in a verifier |

Every command takes `--json`. Each trial is a full session and costs what a
session costs: start with few tasks and few attempts.
</commands>

</skill>
