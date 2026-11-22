# Eval: the factory measures and improves itself

Trigger `factory-eval`, Mondays 07:00 UTC, one keyed session, window 7 days.
Eval reads; it files at most 3 change tickets per pass against the factory's
own configuration. It never changes product code and never merges.

## Metrics (computed in code, never by hand)

| Metric | From | Target |
|---|---|---|
| `merged` | factory pull requests merged in the window (`gh pr list --state merged --search "head:<branch_prefix> merged:>=<date>"`) | at least 1 while `ready` tickets exist |
| `cycle_time_median_h` | first claim → merge, per ticket | falling |
| `first_pass_approve_pct` | merged pull requests whose first review was `approve` | ≥ 70 |
| `rework_cycles_per_pr` | `[factory-feedback] requested` per merged pull request | ≤ 1 |
| `handback_rate_pct` | `handed back` ÷ claims | < 10 |
| `revert_rate_pct` | reverts of factory merges ÷ merges | < 3 |
| `trunk_red` | `[factory-merge] trunk red` comments | 0 |
| `triage` / `ready` / `blocked` | open tickets per state now, against the last ledger row | not rising |
| `stale` | tickets with no comment and no commit for 72 h that are not `blocked` | 0 |
| `per_source` | created, merged, canceled-as-obsolete per source | obsolete < 30 % of created |
| `cost_per_merge` | `kortix usage` or `kortix gateway` spend for factory sessions ÷ merges, when readable | tracked |

## Pass

1. Read the `factory-eval:ledger` ticket (create it on the first run): one row
   per pass in a table.
2. Compute every metric into `/tmp/factory/eval/metrics.json`.
3. **Sample real work**: 3 merged pull requests, 2 hand-backs, 2 blocked
   tickets, the source with the most obsolete tickets. Read them.
4. **Critique**: one comment on the ledger, at most 40 lines:
   ```
   [factory-eval] critique · <date> · window=7d
   verdict: <one sentence, with the two numbers that decide it>
   metrics: <name=value …>
   breaches: <list | none>
   working: <items, each with evidence>
   failing: <items, each with a cause and evidence>
   unknown: <what could not be measured, and why>
   ```
   A pass with no `failing` line is almost always a shallow pass: read again.
5. **Changes**: at most 3 tickets per pass, each one change to the factory's
   own files (`factory.json` caps, models or sources; a trigger schedule; a
   reference file's rule), key `factory-eval:<change-slug>`, label
   `source:factory-eval`, with the evidence, the one metric it should move,
   the direction, and the rule: kept when the metric moves ≥ 10 % that way
   within 2 passes, reverted when it moves ≥ 10 % the other way. No overlap
   with an open change on the same metric. These tickets run through intake
   like any other; their pull requests change the config repository.
6. **Judge** each merged change ticket from earlier passes:
   `[factory-eval] kept|reverted · <metric> <before> → <after>`. Reverted: a
   revert ticket `factory-eval:revert-<slug>`.
7. Append the ledger row.

## Run line

```
factory-eval: merged=<n> cycle_time_median_h=<n> first_pass_approve_pct=<n> handback_rate_pct=<n> triage=<n> blocked=<n> breaches=<n> changes_new=<n> kept=<n> reverted=<n> errors=<none|codes>
```
