---
name: sales-offer-creation
description: Draft a customer offer (proposal) for one deal from the packages and prices a person approved in sales.json, the deal's notes and the company's public facts, as an HTML and PDF draft for a person to review and send. Never invents a price, a term or a discount, and never sends or opens a signing flow. Load it when a person asks for an offer, a proposal or a quote for a deal.
---

# Offer creation

An offer is sales collateral a person reviews, edits and sends. It is never a
contract and never the agent's commitment. The `sales-loop` contract applies.

## Inputs

- `offers.packages` in sales.json: each package a person approved, with its
  name, what it includes, its price and its billing period. `offers.currency`.
- `offers.template`: a repository path to the team's HTML offer template.
  `null`: use `references/offer-outline.md`.
- The deal: its notes, the meeting briefs, the open questions, the contacts'
  roles.
- The customer's public facts (`sales-lead-research`).

No package in sales.json: write no price. Submit one Review decision that asks
a person for the package and the price, and stop.

## Steps

1. Pick the package the deal notes point to. Two fit: offer both, side by
   side. None fits: stop and ask (Review decision).
2. Write the offer in the template's structure: the customer's goal in their
   words, the scope, the package, the price exactly as sales.json states it,
   the next steps, the validity date (30 days unless sales.json says
   otherwise).
3. Every customer fact has a source in the deal notes or the research note.
   Every product claim is on the company's website or in sales.json.
4. Render it: write `offer.html` into `/tmp/sales/offers/<key-slug>/`, then
   print it to PDF with headless Chromium
   (`chromium --headless --no-sandbox --print-to-pdf=offer.pdf offer.html`)
   when Chromium is installed; else deliver the HTML.
5. Copy both files to the session's drive (`/drives/`) and submit one Review
   output: `--title "Offer draft: <company>"`, `--risk medium`,
   `--detail '{"files":[{"path":"<pdf or html>"}],"preview":"<package, price, validity>"}'`.
6. `note.add` on the deal: `[sales-loop] offer · <package> · review`.

## Never

- Never a price, a discount, a payment term, a service level or a legal term
  that sales.json does not state.
- Never commit an offer to a repository: it holds customer data.
- Never send the offer, never create a signing envelope, never email it.
