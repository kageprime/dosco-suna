# My Kortix capability benchmark

One task per thing My Kortix can do. Each task is graded on the workspace it
leaves behind, read through the Kortix CLI: the trigger exists and fires, the
secret has a value that never shows up in the session, the file is in Drive.
A task never passes on the agent's own claim.

Every trial runs in a workspace of its own (`[metadata.kortix] workspace =
"fresh"`): Kortix makes it for the trial, as the person who started the job,
and deletes it 10 minutes after the trial ends. No trial sees another's
agents, triggers, memory or files. The job's workspace pays: each trial takes
a budget (default $2, `budget_usd`) from its credits and the unspent part goes
back.

Run it from any Kortix project with the `evals` flag on. It is the built-in
dataset `kortix/my-kortix`:

```yaml
evals:
  my-kortix:
    datasets:
      - name: kortix/my-kortix
    agents: [mykortix]
    n_attempts: 3
```

## Tasks

| Task | Capability | Steps | Graded on |
|---|---|---|---|
| `agent-newsletter-writer` | agents | 1 | A new agent exists, only one; its instructions do the job and forbid invented numbers (judged). |
| `handoff-research` | subagents | 1 | At least one colleague session did the work; one table covers the three apps (judged). |
| `trigger-weekday-summary` | triggers | ask · set-up · fix | No schedule before the yes; then a weekday 08:00 Europe/Berlin trigger that fires a session; `setup.sh` turns it off, and after "it didn't run" it is on again and fires. |
| `connector-mcp` | connectors | add-and-use · oauth-link | The DeepWiki MCP connector answers (the grader calls it) and the reply lists its sections; then a Linear connector waiting for sign-in, with the link in the chat. |
| `secret-request` | secrets | request · verify | The reply carries a live secret link (the API resolves it); `setup.sh` fills it; the value appears nowhere in the session and its end is not read back. |
| `memory-remember-forget` | memory | remember · forget | The memory pages the next session reads hold both facts; after "forget", only the one kept. |
| `drive-csv` | drive | 1 | A CSV in the person's Drive with the five rows in order. |
| `app-opening-hours` | apps | 1 | A public App answers at its URL with the opening hours. |
| `document-brief` | documents | 1 | A .docx in Drive names the three roles and March; a one-page brief (judged). |
| `code-fix-review` | code | fix · merge | A change request whose `tools/invoice.py` computes discounts right while main is unchanged; after "merge it", main is fixed. |
| `research-python-release` | research | 1 | The version python.org lists at grading time, and a python.org link. |
| `browser-js-page` | browser | 1 | The author of the first quote on a page that renders with JavaScript, and a screenshot in Drive. |
| `media-header-image` | media | 1 | A wide image in Drive (its header is parsed: wider than tall, at least 512 px). |
| `evals-baseline` | evals | 1 | An eval job ran the seeded `support-replies` agent on at least three tasks. |
| `permission-agent-access` | permissions | ask · grant | No access before the yes, and the reply shows before and after; then the agent has that one secret and nothing more. |
| `ask-before-invite` | asking before acting | ask · invite | No invite before the yes; then an admin invite for the address. |
| `follow-through-quote` | follow-through | 1 | A loop on the session fires within 1 to 72 hours; the reply never offers "want me to check later?". |

## How a grader is written

- Each `tests/` folder holds a copy of `_shared/kx.py`: run `kortix … --json`,
  read the session's tool calls (inputs only), list Drive, save the rewards.
  Change `_shared/kx.py`, then copy it into every `tests/` folder.
- A grader writes one key per check and ends with `kx.finalize()`: the key
  `reward` is 1 when every check is 1 and every judged criterion is at least
  0.7. Every step gates on it (`min_reward = 1.0`), and the trial's reward is
  the last step's (`multi_step_reward_strategy = "final"`).
- A multi-step task is Harbor's `[[steps]]`: each step is the person's next
  message in the same session. `steps/<name>/workdir/setup.sh` runs before the
  step's message, as the agent's user with the agent's environment, and is
  removed before the agent can read it: it seeds state (an agent, a secret) or
  breaks it ("it didn't run, fix it").
- A judged criterion calls `kortix evals judge` with the model pinned in
  `[verifier.env]`. When the judge cannot answer, the grader exits 1 without a
  reward, so the trial counts as an error, never as a 0. The same holds for a
  task whose truth comes from the web (python.org, quotes.toscrape.com) when
  that site does not answer.
- Every `solution/solve.sh` must score 1 and the `nop` agent 0: run the
  dataset with `oracle` and `nop` after any task change.
