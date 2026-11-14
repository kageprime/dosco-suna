---
name: competitor-intel
description: Write the weekly competitor digest - the few material changes (launches, features, pricing pages, integrations, funding, positioning) at the competitors in marketing.json and at new entrants in the same category, from primary sources, 5 to 10 sentences, as one GitHub issue. Load for the `competitor-intel` role and whenever a person asks what competitors shipped, a competitive landscape or a positioning check.
---

# Competitor intelligence

A short digest a person reads in one minute. Only what changed since the last
digest, only what matters, every item linked to its primary source.

## Steps

1. **Inputs.** `channels.competitor-intel.competitors` in marketing.json.
   Empty: end with `errors=no-competitors`. The previous digest: the newest
   issue labeled `marketing:competitor-intel`; its date starts the window
   (no previous digest: the last 7 days).
2. **Collect** with `references/sources.md`: for each competitor, its own
   changelog, blog, release notes, docs, pricing page and GitHub releases,
   then news and launch sites. Search for new entrants in the same category.
3. **Keep** only material items dated inside the window: a launch, a feature,
   a pricing or packaging change, an integration, a partnership, funding, a
   positioning change. Drop a competitor with no news; never write "no news".
4. **Write** the issue `[marketing] Competitors <date>`, labels `marketing`
   and `marketing:competitor-intel`:
   - 5 to 10 sentences in total, no sections, no appendix;
   - each sentence one item, with an inline link to its primary source;
   - confirmed facts and inference kept apart: an inference says "likely";
   - one closing sentence at most: the implication for the product.
   Little news: fewer sentences. Never pad.
5. **New entrants** worth tracking: one line under the digest,
   `Track: <domain> — <why>`. A person adds them to marketing.json.
6. Close the previous digest issue with a link to the new one.

`channels.competitor-intel.deliver` is `issue`. A person who wants the digest
in Slack or email sets it in marketing.json and grants the connector; the
agent then posts the same text there and still opens the issue as the record.
