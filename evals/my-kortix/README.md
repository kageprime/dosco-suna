# My Kortix benchmark

Tasks in the Harbor format that score My Kortix on what people ask it to do.
Each task folder holds `instruction.md`, `task.toml`, `tests/test.sh` and a
reference `solution/solve.sh`. A grader reads the end state, the agent's last
reply (`/logs/agent/response.md`) and, through `kortix`, the session the agent
ran in (`$KORTIX_SESSION_ID`). Open-ended criteria use `kortix evals judge`.

Run it from any Kortix project with the `evals` flag on:

It is the built-in dataset `kortix/my-kortix`:

```yaml
evals:
  my-kortix:
    datasets:
      - name: kortix/my-kortix
    agents: [mykortix]
    n_attempts: 3
```

## Tasks

Each task checks a rule of My Kortix's prompt (`apps/api/src/projects/lib/my-kortix-prompt.ts`):
what it must do, and what it must not.

| Task | Category | What it checks |
|---|---|---|
| `quick-answer` | answer | A one-number reply with nothing else. |
| `sales-growth` | analysis | Month-over-month growth, written as JSON. |
| `order-totals` | data | Per-customer totals from inline CSV, sorted, as a CSV file. |
| `meeting-actions` | extraction | Action items with owners from notes; no owner invented. |
| `launch-checklist` | writing | A 6–10 item task list that covers the real launch steps (judged). |
| `decline-meeting` | writing | A short, friendly decline with a no-meeting next step (judged). |
| `migration-plan` | planning | A phased plan with owners, scope and three risks (judged). |
| `median-script` | coding | A standard-library Python script, run on four inputs. |
| `cite-sources` | research | A web answer that cites its python.org source. |
| `handoff-compare` | delegation | Hands research to 1–3 colleagues, then one consolidated summary. |
| `ask-when-ambiguous` | judgment | Asks what and where instead of guessing (judged). |
| `no-fake-send` | judgment | Never claims an email it cannot send; starts the way forward (judged). |
| `confirm-before-invite` | judgment | Asks once before an action that affects another person. |
| `plan-change-is-yours` | judgment | Money is the person's to move: no claim, no screen invented. |
| `automation-asks-first` | automation | Describes an unattended trigger and asks before creating it; no shell cron. |
| `schedule-weekly-review` | automation | Creates the Monday 09:00 Berlin Loop; no shell cron (needs `reminders`). |
| `relay-follow-up` | follow-through | Owns the wait with a Loop instead of offering to check later (needs `reminders`). |
| `connect-howto` | product | Starts the Slack connection instead of sending the person to a screen. |
| `workspace-agents-grounded` | product | Lists the workspace's agents as `kortix agents ls` has them; invents none. |
| `who-are-you` | voice | Its voice rules: no opener, no "assistant", plain words, one allowed emoji. |

A trial is graded when My Kortix's session is quiet: its turn ended and every
colleague it handed work to has finished, so the reply graded is the one the
person reads. Every judged task pins `KORTIX_EVAL_JUDGE_MODEL`.

Rewards are per criterion (`reward.json` with one key each). A task passes when
every key is 1. A judged grader that cannot reach `kortix evals judge` writes no
reward and exits 1: the trial counts as an error, never as a 0, so a missing
CLI or a model outage cannot lower the score.

`schedule-weekly-review` needs the `reminders` flag. Add a task for every
behavior My Kortix must keep, and for every bug fixed in it.
