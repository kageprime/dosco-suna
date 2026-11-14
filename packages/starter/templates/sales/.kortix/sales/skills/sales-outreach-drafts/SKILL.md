---
name: sales-outreach-drafts
description: Draft one outreach message (a first touch, a follow-up or a reply) for a qualified lead, grounded in the research note, and deliver it as a draft for a person to send, per the approval mode in sales.json. Never sends. Load it after qualification in the Sales Factory, and when a person asks for an outreach or follow-up draft.
---

# Outreach drafts

A draft is a proposal to a person, not a message to a lead. The person sends
it. The `sales-loop` contract applies; its hard rules 1, 8 and 9 are
absolute.

## When to draft

| Lead | Draft |
|---|---|
| tier `hot` or `warm`, no `drafted` marker | `first-touch` |
| an inbound lead with a message | `reply`, whatever the tier, unless `disqualified` |
| a `drafted` marker older than 4 business days, no reply, under `caps.follow_ups_per_lead` | `follow-up-<n>` |
| `cold`, `disqualified`, opted out, or over `caps.drafts_per_day` | none |

## Write the draft

- **From** `company.sender`. **To** the lead's address from the record.
- **Subject**: at most 6 words, specific to them, no clickbait, no "Re:" on a
  first touch.
- **Body**: at most 120 words. One line that shows you read their situation
  (a fact from the research note, never flattery). One line on what
  `company.product_one_line` does for a team like theirs. One question or one
  concrete next step. The sender's name.
- A `reply` answers their message first, in their words' order, then the next
  step.
- A `follow-up` adds one new, useful fact; it never repeats the first touch
  and never guilt-trips.
- No price, discount, customer name, benchmark or feature that sales.json or
  the company website does not state. No fake urgency. No tracking links.
- The lead's language when their message used one; else the company's.

## Deliver it (contract §6)

1. `approval.outreach: approve_to_send` and the policy check passes: call the
   send tool once. The call waits for a person on the Review page. Never
   repeat the call. Else continue as `draft`.
2. `approval.draft_in`:
   - `mailbox`: the mail connector's create-draft tool
     (`kortix connectors show <slug>` names it), in the thread for a reply.
   - `record`: `note.add` on the person with the draft.
3. Always submit one Review output:

```sh
kortix review submit --kind output --title "Draft: <company> (<tier>)" \
  --summary "<why now, one line> · <first-touch|follow-up-n|reply>" \
  --risk low --detail '{"preview":"<subject>\n\n<body>","record":"<record link>"}'
```

4. `note.add`: `[sales-loop] drafted · <type> · <review|mailbox|record>`, with
   the subject line only, and the `sales-key:` line.
