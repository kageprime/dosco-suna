---
name: sales-lead-research
description: Research one lead (a company and a person) from public sources only, and write one cited research note into the system of record. Load it for every new lead of the Sales Factory, and whenever a person asks who a company or a contact is before a call.
---

# Lead research

One lead in, one research note out. Every line of the note has a source URL.
The `sales-loop` contract applies; its hard rule 2 (public sources only) is
absolute.

## Sources, in order

| Source | What to read |
|---|---|
| the company website | what they do, who they sell to, the size signals (team page, careers page, customer logos they publish), the tech they name |
| public filings and registries | the legal name, the country, the founding year, when the website does not say |
| press and the company blog, the last 12 months | funding, launches, hires, partnerships: a reason to talk now |
| job posts | the teams that grow, the tools they hire for |
| public code (GitHub organization) | the stack, the activity, when the product is technical |
| the person's public professional profile and the company team page | the role, the team, the time in the role |

Never: a data broker, a people-search site, a leaked or breached dataset, a
guessed email pattern, a personal social account, a page behind a login.
A fact you cannot source is left out.

## Steps

1. Read the record first (`note.list`). A `[sales-loop] researched` note
   younger than 30 days: add only what is new since it, or stop.
2. Find the company domain: the email domain, else `website`. A personal
   email domain with no company: research the person's public professional
   profile only, if the payload names a company; else note "no company found"
   and stop.
3. Read the sources above with the web tools. At most 12 pages per lead.
4. Write the note (format below) with `note.add` on the company, and a short
   pointer note on the person.
5. Fill empty company fields (`company.upsert`): name, website, industry,
   size band, country. Never overwrite a field a person set.

## The research note

```markdown
[sales-loop] researched
**Company.** <one line: what they do, for whom.> (<url>)
**Size.** <employee band or "unknown">, <country>. (<url>)
**Why now.** <the newest relevant event, with its date, or "nothing found">. (<url>)
**Person.** <role and team>, <time in role if public>. (<url>)
**Stack and fit signals.** <bullets that the ICP cares about>, each (<url>)
**Open questions.** <what a person should find out on a first call>
sales-key: <key>
```

At most 15 lines. No adjectives the sources do not support. No guesses
marked as facts: write "unknown".
