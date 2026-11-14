# Source: GitHub issues

Trigger `source-github-issues` (GitHub webhook `issues`, action `labeled`,
label `kortix`). One run per labeled issue. Enabled by default.

| | |
|---|---|
| Signal | a person adds the accept label (`labels.accept`, default `kortix`) to an issue of the code repository |
| Finding | the issue itself: a bug, a feature or a task a person wants built |
| Bar | a person added the label (prove it: `stores/github-issues.md` → Who the factory works on). The issue is clear: the surface, the action, the observed and the expected result (bug), or what should change and the result wanted (feature). An unclear issue is still filed; the worker blocks with the exact missing items (`kind:feature` route of `execution/worker.md`) |
| Key | `github:<owner>/<repo>#<number>` |
| Signal value | `signal: reactions=<n> comments=<n>` |
| Priority | `priority:<n>` label when present, else 2 for a bug, 3 otherwise |
| Kind | the issue's `bug` / `enhancement` label, else read the text: `bug` or `feature` or `task` |
| Credentials | `FACTORY_GITHUB_TOKEN` (read the issue); the store's credentials |
| Cap | never capped: a person asked (contract hard rule 5) |

## Run

1. Read factory.json. `sources.github-issues.enabled` false: end, `errors=disabled`.
2. `gh issue view <n> -R <repo> --json number,title,body,state,labels,author,url`.
   Closed: end with `skipped_open=0 not_filed=1`.
3. Prove the label came from a person (not the agent's own login, not a bot).
   Not proven: end, `not_filed=1`.
4. **The store is GitHub Issues on this repository** (`store.target` equals the
   code repository): the issue is the ticket. Add `factory`, `source:github-issues`,
   `kind:<k>`, `priority:<p>` and `factory:ready` (a person's label is the accept,
   so the ticket skips `triage`). Post one comment
   `[factory-intake] accepted · labeled kortix → ready`. Do not rewrite the
   person's issue body and do not add a key line: its key is its number.
5. **Any other store** (Linear, Jira, Asana, JSON, or another repository):
   `ticket.find_by_key(github:<owner>/<repo>#<n>)`, then upsert (contract §5) one
   ticket: the title `[factory] <the issue title>`, the body of contract §6 with
   `## What` a paraphrase of the issue, `## Evidence` the issue URL, the
   reporter's steps paraphrased, and the key line. State `ready` (a person
   accepted it). Comment on the GitHub issue once:
   `Tracked by the Software Factory as <ticket reference>.`
6. Start intake now instead of waiting up to 5 minutes:
   `kortix triggers fire factory-intake`. A `403`: skip it; intake runs on its
   schedule.
7. End with the source run line (contract §17), `source-github-issues:` first.

## Every opened issue (opt-in)

`sources.github-issues.accept: "all"` makes every new issue factory work. Then
change the trigger filter to `body.action: { in: [opened, labeled] }`, and add
the accept label to every issue this run files. Only for a private repository:
on a public one, any stranger could start a worker with an issue text.
