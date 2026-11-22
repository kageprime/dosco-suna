---
name: recruiting-scheduling-drafts
description: Draft the message that invites one advanced candidate to schedule the next interview, with the scheduling link or proposed times from recruiting.json and the calendar. Never sends and never books. Load it in the Recruiting Factory after the interview kit for an advanced candidate.
---

# Scheduling drafts

The contract is `recruiting-loop`. Run only after a `decided · advance` note.
A person approves every message (contract §1 rule 2).

## Steps

1. Read `company.scheduling_link`. Set: the draft offers the link.
2. No link, and a calendar connector is connected: read the interviewers'
   free/busy for the next 10 business days, in the time zone of the role's
   `location`. Propose 3 slots of the stage's length, in business hours, at
   least 1 business day out. Never book, never hold a slot, never send an
   invite.
3. Neither: the draft asks the candidate for 3 times that suit them.

## The draft

- To: the candidate's email from the record. Subject: `<role title>: next
  step with <company.name>`.
- At most 120 words: thanks, the stage and its length, who they meet (role
  titles only), the link or the slots, and how to ask for an adjustment
  ("If you need any adjustment for the interview, reply and tell us").
  Signed with `company.sender`.
- Never a salary, a timeline, a promise or a decision a person did not make
  (contract §1 rule 12).

Deliver it per contract §7 with the marker
`[recruiting-loop] drafted · scheduling`.
