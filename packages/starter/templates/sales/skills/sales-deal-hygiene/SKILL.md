---
name: sales-deal-hygiene
description: Weekly pipeline hygiene over the open deals in the system of record - stale deals, missing next steps, missing owners, close dates in the past, leads over the cap waiting for research - with one task per finding and one digest for the team. Load it in the `sales-deal-hygiene` run and when a person asks for a pipeline review.
---

# Deal hygiene

The pipeline is only as good as its freshest record. This pass finds what
rotted and hands each item to its owner. The `sales-loop` contract applies.

## Findings

Read `deal.list_open()` into `/tmp/sales/hygiene/deals.json`, then compute in
code:

| Finding | Rule |
|---|---|
| `stale` | no activity for `caps.stale_deal_days` days |
| `no-next-step` | no open task and no meeting in the next 14 days |
| `no-owner` | the owner is empty or a deactivated user |
| `closing-past` | the close date is before today and the deal is open |
| `missing-research` | a lead with a `[sales-loop] skipped · over the cap` note and no `researched` note |

## Act

1. For each finding: one `task.create` for the deal owner (no owner: the
   person in `notify.digest`, or none), title
   `Pipeline: <finding> on <deal name>`, due in 2 business days, and one note
   `[sales-loop] hygiene · <finding>` with the evidence line. One open hygiene
   task per deal and finding: never a second one while the first is open.
2. `missing-research`: run lead research and qualification for up to half of
   `caps.leads_researched_per_day`, oldest first.
3. `stale` deals of tier `hot` or `warm` with a contact: a `follow-up` draft
   (`sales-outreach-drafts`), under the caps.
4. Never change a stage, an amount, a close date or an owner, whatever
   `record_writes` says: a person decides those. Propose them in the digest.

## The digest

One Review output, `--title "Pipeline hygiene: <ISO week>"`, and one post to
`notify.digest` when it is set. Counts per finding, the 10 deals that most
need a person (deal name and owner only, no contact data), and the proposed
stage or date changes.

## Run line

```
sales-deal-hygiene: deals=<n> stale=<n> no_next_step=<n> no_owner=<n> closing_past=<n> tasks=<n> drafted=<n> errors=<none|code>
```
