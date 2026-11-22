---
name: recruiting-candidate-updates
description: Draft a message to a candidate — the reject a person decided, a status update when the team has been silent, an answer to a candidate's question, or a first message to a referred or sourced person a person approved. Never sends; a person approves every message. Load it in the Recruiting Factory whenever a candidate needs to hear from the team.
---

# Candidate updates (drafts)

The contract is `recruiting-loop`. A person approves every message (contract
§1 rule 2). A draft never states a decision a person did not make.

## Kinds

| Kind | When | What it says |
|---|---|---|
| `reject` | a `decided · reject` note | thanks, the decision, one honest sentence, an invitation to apply again only when a person said so |
| `status` | no message from the team for `caps.no_update_days` | where the process is; when the candidate hears next only when a person set a date |
| `answer` | a candidate asked a question (the inbox source) | the answer from recruiting.json, the role or the careers page; anything else: "a person from the team will answer" |
| `referral-intro` | a referral or a sourced person a person approved | who referred them, only when the referral states the referrer agreed to be named, or where the team saw their public work; the role; the next step |

## Rules for every draft

1. At most 150 words, plain and warm, signed with `company.sender`.
2. A `reject` gives no score, no ranking, no comparison and no reason that
   names a protected attribute. It gives a job-related reason only when the
   person's decision states one.
3. Never a salary, a benefit, a timeline, a visa promise or a feedback call a
   person did not offer.
4. A candidate who asked to have their data deleted, or who withdrew: no
   draft. A Review `decision` item instead (contract §8).

Deliver each per contract §7 with the marker
`[recruiting-loop] drafted · update-<kind>`.
