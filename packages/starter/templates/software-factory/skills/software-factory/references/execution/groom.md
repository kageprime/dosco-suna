# Groom: the store stays clean

Trigger `factory-groom`, daily at 06:00 UTC, one keyed session. Groom is the
only writer of a ticket's priority, title, labels and body after the create
(a worker may edit its own ticket's body and keeps the key line).

## What groom may change

Open factory tickets the factory filed, in `triage`, `ready` or `blocked`.
Never a ticket `in_progress` or `in_review` (a worker owns it), never a
person's own ticket (it only comments there), never a `done` or `canceled`
ticket. Re-read each ticket right before each write; a state that changed:
skip it.

## Pass

1. **Snapshot** (`ticket.list`, in code). Clone the trunk read-only.
2. **Merge duplicates.** Same code anchor and same defect (contract §5, step
   3). Keep the oldest with the most evidence; fold the other's evidence into
   its body under `related-keys: <key>, …` (above the key line);
   `[factory-groom] merged into <kept>` and `ticket.cancel` the other.
3. **Fold small tickets** of the same files into one pull-request-sized ticket
   the same way, at most 5 per package.
4. **Obsolete.** Re-check each ticket's evidence at the trunk: the code is
   gone or already fixed, the test passes, the dependency is upgraded.
   `[factory-groom] obsolete · <evidence at <trunk> <sha7>>` and
   `ticket.cancel`.
5. **Rewrite stale bodies** in place when the anchor moved (new file or line),
   keeping every contract §6 section and the key line last.
   `[factory-groom] rewritten · <what changed>`.
6. **Priority** by the contract §6 rubric against the newest `signal:` line;
   at most 25 changes per pass, each with `[factory-groom] priority <old> →
   <new> · <reason>`.
7. **Unblock** every `blocked` ticket older than 24 h, oldest first:

| Blocker | Decision |
|---|---|
| a decision the factory can make (a default, a naming choice, a scope cut) | `[factory-intake] retry · decide it yourself: <the default>`; intake dispatches |
| the pull request is merged | `set_state(done)` with `[factory-merge] merged · PR <url>` |
| a product, policy, budget or access decision; a credential; a production change; an external party | `[factory-groom] needs a human · <class>: <exactly what, and who decides>`, once per block |
| the defect is gone at the trunk | obsolete (step 4) |
| too large, unclear, two closed pull requests | **rescope**: rewrite the body into one pull-request-sized slice with outcome checkboxes and a `## Blocker resolved` section, then `[factory-intake] retry · rescoped by groom` |

8. **Hygiene.** A factory ticket in `triage` with no source label: add it from
   the key. A `json-file` store: move tickets `done` or `canceled` for 90 days
   into the archive file.

## Run line

```
factory-groom: open=<n> merged=<n> obsolete=<n> rewritten=<n> priority=<n> unblocked=<n> rescoped=<n> needs_human=<n> errors=<none|codes>
```
