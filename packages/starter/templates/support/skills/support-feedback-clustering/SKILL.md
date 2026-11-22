---
name: support-feedback-clustering
description: Cluster 30 days of support conversations and in-app feedback by surface and theme, count conversations and distinct customers, and write one weekly Review output; clusters above the bar become Software Factory feature tickets. Never quotes a customer. Load it from the support-feedback-clusters trigger, or when a person asks what customers ask for most.
---

# Support feedback clustering

Trigger `support-feedback-clusters` (weekly, Monday 08:00 UTC). Output: one
Review output, and at most 3 new tickets. The `support-loop` contract rules
apply.

## 1. Collect, into files

- The desk: `conversation.list_updated(<now - 30 days>)`, then for each the
  `[support-loop] triaged` note. Keep the key, the category, the surface, the
  one-line need and the desk's customer reference.
- In-app feedback: `kortix review ls --kind output --json`, the items titled
  `Feedback:` from the last 30 days.
- Slack: the Review outputs titled `Slack:` from the last 30 days.

Write it all to `/tmp/support/clusters/items.json`. Never paste it into the
conversation.

## 2. Cluster

Group in code first by `surface`, then by reading within each surface: one
theme is one need ("export to CSV is empty", "wants SSO on the team plan").
For each cluster count `conversations_30d` and `customers_30d` (distinct
customer references, counted, never listed) and the trend against the 30
days before.

## 3. The bar

| Cluster | Action |
|---|---|
| a `bug` theme | already handed off by `support-bug-handoff`: check that its ticket exists and carries the newest count |
| a `feature-request` or `how-to` theme with `customers_30d >= 3` | a feature ticket through `support-bug-handoff` step 3, `kind:feature`, key `support:<theme slug>`; at most 3 new per run |
| a `how-to` theme with `customers_30d >= 3` and no docs page that answers it | a docs gap for `support-docs-gaps` |
| anything else | the digest only |

## 4. Write

One Review output:

```sh
kortix review submit --kind output --title "Support clusters · week of <ISO date>" \
  --summary "<n> conversations, <n> clusters, top: <theme>" \
  --detail '{"preview":"<the table>"}'
```

The table: theme, surface, category, `conversations_30d`, `customers_30d`,
trend, action taken (ticket link, docs gap, none). Paraphrase every theme.
Never a customer's name, company, email or words. Send one line to
`notify.digest` when support.json names it.

## 5. The run line

```
support-feedback-clusters: items=<n> clusters=<n> tickets_new=<n> tickets_updated=<n> docs_gaps=<n> errors=<none|code>
```
