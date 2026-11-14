---
name: recruiting-sourcing
description: Build a weekly list of people who match an open role, from public professional profiles and public work only, scored against the role's rubric. Contacts nobody; a person approves the list before any first-message draft. Load it in the Recruiting Factory from the `recruiting-sourcing` trigger, for roles whose `sourcing.enabled` is true.
---

# Sourcing: a list for a person, never outreach

The contract is `recruiting-loop`. Every hard rule applies, with these
additions.

## Rules

1. **Public professional sources only:** public code (repositories, merged
   contributions), conference talks, published papers, technical posts on a
   personal or company site, a public professional profile page. Never a data
   broker, a people-search site, a contact-finder tool, a leaked dataset, a
   personal social account, or a page behind a login.
2. **No contact details.** The list holds the public profile URL only. Never
   find, guess or enumerate an email or a phone number.
3. **Contact nobody.** No message, no connection request, no follow, no
   comment. A first-message draft exists only after a person approved that
   person on the list.
4. **The same rubric.** Score only the role's `signals` from the public work,
   on the screening scale. No protected attribute, no inference from a name,
   a photo or a school.
5. **Opt-outs win.** A profile that says it does not want recruiter contact
   is never listed.

## Steps

1. For each role with `sourcing.enabled: true`, run its `sourcing.queries`
   (search terms a person approved) against public sources.
2. Keep at most `caps.sourced_per_role_per_week` people per role, highest
   score first. Skip anyone already in the system of record for the role.
3. Submit one Review `decision` per role: the list with, per person, the
   profile URL, the signals with the public evidence, and the score. The
   person answers with the profile URLs they approve.
4. The next `recruiting-decisions` pass reads the answer and drafts one
   `referral-intro` message per approved person (`recruiting-candidate-updates`),
   in `draft` mode only, with where the team saw their public work. The
   person finds the contact route.
5. A person who is not approved leaves no trace: the loop keeps no record of
   them beyond the Review item.

## Run line

```
recruiting-sourcing: roles=<n> listed=<n> decisions_requested=<n> errors=<none|code>
```
