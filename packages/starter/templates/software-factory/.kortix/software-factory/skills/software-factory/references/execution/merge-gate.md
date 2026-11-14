# Merge gate

Trigger `factory-merge`, every 10 minutes, one keyed session. The only role
that merges, and only under `merge.policy` (contract §12). It never writes
code and never pushes.

## Candidates

Open pull requests into the trunk, oldest first, whose ticket's newest cycle
marker is `[factory-worker] handoff` naming that pull request:
`gh pr list -R <repo> --base <trunk> --state open --json number,headRefName,headRefOid,isDraft,labels,author,updatedAt,mergeable,mergeStateStatus,reviewDecision`
into a file. The branch starts with `repository.branch_prefix`; the ticket
reference is in the title or body.

## Gates (every one on the current head)

| Gate | Holds when |
|---|---|
| G0 feedback | a `[factory-feedback] requested` is newer than the handoff, or a person commented on the pull request in the last 20 min (the feedback sweep has not read it yet) |
| G1 label | `do-not-merge` |
| G2 person | a person's latest review is `CHANGES_REQUESTED` |
| G3 conflict | `mergeable: CONFLICTING`: route it once per head: `[factory-feedback] requested · PR <url> · items=1` with `Git: merge conflict with <trunk> on head <sha7>: merge origin/<trunk>, resolve, re-run the covering tests, push, hand off again`. A conflict is never a held comment |
| G4 checks | a required status check fails or is pending (`gh pr checks <n> --required`). No required checks: the gate reads the handoff's test evidence instead |
| G5 evidence | the body misses **Review in 60 seconds**, a test summary with a pass count, the `Self-review:` line, or a demo for a visible change; or it holds a placeholder (contract §11) |
| G6 review | no `[factory-review] approve` for this exact head. Start a reviewer when none runs for this head and fewer than `caps.reviewers` run: `kortix sessions new --agent factory --model "$REVIEWER_MODEL" --label factory-reviewer --context factory.role=reviewer --prompt "[factory] role=reviewer ticket=<id> pr=<n> head=<sha7>\nFollow references/execution/review.md." --json`. A `request_changes` for this head: post `[factory-feedback] requested` with its items, once per head |
| G7 policy holds | `source:security`; the diff touches a path in `merge.hold_paths`; a big visual change (`merge.big_visual`: count the changed UI, style and copy files and their lines from `gh pr diff <n> --name-only` and `--stat`, never by judgment) or the reviewer's `big_visual: yes` |

## Act

- A gate holds (except G3 and G6 waiting for a running reviewer): one
  `[factory-merge] held · <gate>: <reason> · head <sha7> · PR <url>` per head;
  never repeat it for the same head.
- Every gate passes, `merge.policy: hold`, or G7 holds: add the label
  `needs-review`, `[factory-merge] held · ready for a person · head <sha7>`
  once per head, one line to `notify.held_prs` when set. A person merges.
- Every gate passes, `merge.policy: auto`, G7 passes: re-read the head right
  before the merge, then
  `gh pr merge <n> -R <repo> --squash --match-head-commit <full sha> --delete-branch`.
  Never `--admin`. Then `[factory-merge] merged · <merge sha7> · PR <url>`,
  `set_state(done)` (GitHub Issues: `Closes #<n>` closes it).
- A person merged a factory pull request: post `[factory-merge] merged ·
  <sha7> · merged by a person` and `set_state(done)`.

## After a merge

Read the trunk's checks on the merge commit on the next passes
(`gh run list -R <repo> --branch <trunk> --commit <sha> --json conclusion,url`).
Red, and the failure is in the merged diff or reproduces on a rerun:
`[factory-merge] trunk red · merge <sha7> · <check>` and
`[factory-intake] retry · trunk red after merge <sha7>` (the ticket goes back
to `ready`; its worker fixes forward or reverts with a pull request). Never
push a revert.

## Run line

```
factory-merge: candidates=<n> merged=<n> held=<n> ready_for_person=<n> conflicts_routed=<n> reviewers_started=<n> trunk_red=<n> errors=<none|codes>
```
