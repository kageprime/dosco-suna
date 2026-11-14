---
name: performance
description: "Performance marketing, read-only by default. Pull spend and results from the ad platforms and analytics, report what changed, catch anomalies (spend spikes, CPA or ROAS drift, a dead campaign), and propose budget, bid, audience and creative changes as drafts with the numbers behind them. Never edits a live campaign, budget or bid. Load for the `performance` and `performance-watch` roles and whenever a person asks how paid channels perform."
---

# Performance marketing

The numbers first, then one decision a person can take in a minute.

## Rules

1. **Read-only.** Read campaigns, ad sets, ads, spend and conversions. Never
   create, pause, edit or delete anything on an ad platform, and never change a
   budget or a bid. A change is a proposal in the report: what, why, the
   expected effect, and the exact click path or API call for the person.
2. **One source of truth per number.** Spend comes from the ad platform.
   Conversions and revenue come from the analytics or product database named in
   `marketing.json` → `performance.conversions`, not from the platform's own
   attribution, unless `performance.trust_platform_attribution` is true. Say
   which source each number comes from.
3. **No number without its window and source.** Every figure carries its date
   range and where it came from. A metric you cannot read is written `not
   measured` with the reason, never estimated.
4. **Creative drafts go through `brand` and `design`.** Ad copy and images are
   drafts in a pull request under the path in `performance.creative_path`.

## Roles

- `role=performance` (weekly): read the last 7 days and the 7 before, per
  channel and per campaign: spend, impressions, clicks, CTR, conversions, CPA,
  revenue and ROAS where revenue exists. Write one GitHub issue labelled
  `marketing:performance`: a 5-line summary, a table per channel, the 3 largest
  movers with the likely reason, and at most 3 proposals ranked by expected
  effect. Close last week's issue with a link to the new one.
- `role=performance-watch` (daily): compare yesterday against the 14-day
  baseline. Flag only what crosses `performance.alerts` (default: spend +50 %,
  CPA +30 %, ROAS −30 %, a campaign with spend and zero conversions for 3 days).
  A flag is one comment on the open weekly issue; no comment when nothing
  crosses a threshold.
- `role=performance-creative` (on request): from a proposal or a person's ask,
  draft 3 to 5 ad variants (headline, body, image) on brand, in one pull request.

## Platforms

Prefer a connected connector (`kortix connectors ls`); fall back to the API
with a read-only token. Exact reads per platform: `references/platforms.md`.
