---
name: support-bug-handoff
description: Hand one product defect from a support conversation to engineering - into the Software Factory's ticket store when the repository has one (.kortix/software-factory/factory.json), else a GitHub issue labeled support-bug, else a Review output. One ticket per defect key, paraphrased, never customer data. Load it for contract step 4 of the support-loop skill, or when a person asks to file a bug from support.
---

# Support bug handoff

Input: one conversation triaged `bug` (or a `feature-request` that the
clustering bar promotes). Output: one ticket per defect, created or updated,
and one `[support-loop] handed off` note on the conversation. The
`support-loop` contract rules apply.

## 1. The defect key

`support:<defect slug>`: the surface and the defect class, slugged, for
example `support:reports-export-empty-csv`. Lowercase, `a-z 0-9 : . _ -`
only. Never a customer, a conversation id or an email. Two conversations
about the same defect get the same key.

## 2. Reproduce when you can

Read the code path (`support-answer-drafts` step 1.2). Name the file and the
symbol that most likely holds the defect. Do not run the product against
production data; the engineering side reproduces it in its own sandbox.

## 3. Where the ticket goes, first match wins

1. **The Software Factory.** `/workspace/.kortix/software-factory/factory.json`
   exists (`handoff.factory_config`). Load
   `/workspace/.kortix/software-factory/skills/software-factory/SKILL.md` and
   follow its §4 (dedup key and the `factory-key:` last line), §5 (upsert:
   never a duplicate) and §6 (ticket body), and the reference for its
   `store.kind` under `references/stores/`. Use:
   - labels `factory`, `source:support`, `kind:bug` (`kind:feature` for a
     promoted request);
   - key `support:<defect slug>`, as the body's last line
     `factory-key: support:<defect slug>`;
   - title `[factory] <imperative, at most 80 characters>`;
   - body sections `## What`, `## Evidence` (the surface, the steps, the
     expected and actual result, `file:symbol` when found, and
     `signal: conversations_30d=<n> customers_30d=<n>`), `## Proposed change`,
     `## Acceptance`, `## Source` (`support inbox · <n> conversations in 30 days`);
   - state `triage` and the priority of triage.
   An open ticket with the key: no create; post `[factory-source] update`
   with the new `signal:` line only when the count grew by at least 25 % and
   no update was posted in 24 hours. The factory's own
   `source-support-inbox` trigger must stay disabled while this loop runs:
   one producer per signal. Setup checks it.
2. **GitHub issues.** No factory, and `GH_TOKEN` is set: search
   `gh issue list --repo {{repoFullName}} --label <handoff.github_label> --state all --search "support-key: support:<slug>" --json number,state,url`.
   None: `gh issue create --repo {{repoFullName}} --label <handoff.github_label> --title "<title>" --body "<the same sections>"`
   with `support-key: support:<slug>` as the last line. Open: comment with the
   new counts, under the same 25 % / 24 h rule. Closed less than 72 hours ago:
   nothing. Closed earlier: reopen with a comment that it reoccurred.
3. **The Review page.** Neither: `kortix review submit --kind output --title "Bug: <title>" --detail '{"preview":"<the body>"}'`.

At most `caps.bug_tickets_per_day` new tickets per UTC day. Over the cap:
the conversation gets the `handed off` note with `pending: over the cap`, and
the next run files it.

## 4. Paraphrase, always

The ticket says "a customer on the team plan exports a report and gets an
empty CSV". It never holds a customer's name, email, company, account id,
message text, screenshot or a link to the conversation.

## 5. Link back

```
[support-loop] handed off · <ticket url or id> · support:<slug>
support-key: <conversation key>
```

The draft to the customer (`support-answer-drafts`) says a person will update
them; it never names an internal ticket or a date.
