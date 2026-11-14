---
name: sales-qualification
description: Score one researched lead against the ICP in sales.json (must-haves, nice-to-haves, disqualifiers, thresholds) and write the score, the tier and a cited scorecard into the system of record. Load it after lead research in the Sales Factory, and when a person asks whether a lead fits.
---

# Qualification

The ICP lives in `sales.json` → `icp`. The score is arithmetic over the
ICP's own criteria, never a feeling. The `sales-loop` contract applies.

## Inputs

- the `[sales-loop] researched` note of the lead;
- the webhook or form payload, when there is one (plan, message, source);
- the ICP: `segments`, `must_have`, `nice_to_have`, `disqualifiers`,
  `thresholds.hot`, `thresholds.warm`.

No ICP in sales.json (`icp.summary` is `null` and the lists are empty): score
nothing, write `[sales-loop] skipped · no ICP`, and submit one Review
decision that asks a person to fill the ICP. Once per day at most.

## Scoring

1. **Disqualifiers first.** Any disqualifier with evidence: tier
   `disqualified`, score 0, stop. Name the disqualifier and its source.
2. **Must-haves: 60 points**, split evenly. Each must-have is `met` (full
   share, with evidence), `unknown` (half share) or `not met` (zero).
3. **Nice-to-haves: 30 points**, split evenly, `met` or not.
4. **Intent: 10 points.** An inbound request for a demo or pricing: 10. A
   signup on a paid plan: 8. A signup on a free plan: 4. A lead from a CRM
   import with no activity: 0.
5. Sum, round to an integer. `>= thresholds.hot`: `hot`. `>= thresholds.warm`:
   `warm`. Else `cold`.

A criterion is `met` only with a fact from the research note or the payload.
More than half the must-haves `unknown`: cap the tier at `warm` and say what
to find out.

## Write

1. `field.set`: `kortix_score`, `kortix_tier`, `kortix_lead_key`.
2. `note.add` on the company:

```markdown
[sales-loop] qualified · score <n> · tier <tier>
| Criterion | Result | Evidence |
|---|---|---|
| <must-have> | met / unknown / not met | <fact> (<url>) |
| … | | |
Intent: <n> (<why>)
Next: <one line: draft now, ask a question, or nothing>
sales-key: <key>
```

Never write a protected attribute (age, gender, ethnicity, religion,
nationality of a person) into a scorecard, and never score on one.
