---
name: sales-meeting-prep
description: Write a one-page brief for every external sales meeting on today's calendar, from the system of record and public sources, and deliver it to the Review page and the record. Load it in the `sales-meeting-prep` run and when a person asks to prepare a call with a company.
---

# Meeting prep

One brief per external meeting, ready before the day starts. The `sales-loop`
contract applies.

## Find today's meetings

1. `meeting_prep.calendar_connector` in sales.json (for example
   `googlecalendar`): `kortix connectors show <slug>` for the list-events tool,
   then list today's events of the connected calendar, 00:00 to 23:59 in the
   calendar's time zone. Not set: `errors=no-calendar`.
2. Keep an event when at least one attendee's domain is not in
   `meeting_prep.internal_domains` and not a personal email domain. Drop
   declined events and events with no attendees.
3. Never read event descriptions of other calendars, never change an event.

## For each meeting

1. Key the external domain (contract §3). `company.find`, `person.find` for
   each external attendee, `note.list`, the open deal for the company.
2. No `researched` note younger than 30 days: run `sales-lead-research`
   first, under the caps.
3. Write the brief:

```markdown
[sales-loop] meeting brief · <ISO date>
**Meeting.** <title>, <time>, <external attendees: role only>.
**Company.** <one line> · tier <tier>, score <n>.
**Where we are.** <deal stage, last touch and its date, open tasks>.
**Why now.** <the newest relevant event> (<url>).
**Goals for this call.** <2 to 3 bullets from the ICP's unknown must-haves>.
**Questions to ask.** <3 to 5>.
**Watch-outs.** <a disqualifier risk, a competitor they use, an open issue>.
sales-key: <key>
```

4. `note.add` on the company or the deal. Submit one Review output per
   meeting: `--title "Brief: <company>, <time>"`, `--detail '{"preview":"<brief>"}'`.

## Run line

```
sales-meeting-prep: meetings=<n> briefs=<n> researched=<n> errors=<none|code>
```
