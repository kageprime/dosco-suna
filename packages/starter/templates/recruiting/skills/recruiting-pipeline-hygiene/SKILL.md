---
name: recruiting-pipeline-hygiene
description: The weekly pass over every open application in the system of record — candidates stuck in a stage, candidates with no update, applications with no owner, decisions waiting on a person, and data past the retention period. Writes notes, status drafts and one digest; never moves, rejects or archives. Load it in the Recruiting Factory from the `recruiting-pipeline-hygiene` trigger.
---

# Pipeline hygiene

The contract is `recruiting-loop`.

## Steps

1. `application.list` for every active application of the mapped roles, into
   a file. Reduce it in code to: key, role, stage, owner, days in stage, days
   since the last message from the team, newest loop marker.
2. Classify each application, in this order, first match wins:

   | Class | Rule | Action |
   |---|---|---|
   | `retention` | past `retention_days` (contract §8) | contract §8 |
   | `waiting` | a Review `decision` item open for more than 3 days | a line in the digest |
   | `no-owner` | no owner in an active stage | a `hygiene · no-owner` note |
   | `stuck` | in one stage for `caps.stuck_days` or more | a `hygiene · stuck` note |
   | `no-update` | no message from the team for `caps.no_update_days` | a `status` draft (`recruiting-candidate-updates`), under `caps.drafts_per_day` |

   One note per application per week: skip it when a `hygiene` note with the
   same class is younger than 7 days.
3. **The digest.** One Review output (`--kind batch`), and one message to
   `notify.digest` when set: counts per role and stage, then the lines per
   class by key suffix and record link. No names, no emails.
4. **Rubric check.** Per role, count the screened applications by tier and by
   the person's decision. A tier where more than 90 % of decisions differ from
   the recommendation: one line in the digest that asks a person to review
   the rubric. Never count by a protected attribute.

## Run line

```
recruiting-pipeline-hygiene: open=<n> stuck=<n> no_update=<n> no_owner=<n> waiting=<n> retention=<n> drafted=<n> errors=<none|code>
```
