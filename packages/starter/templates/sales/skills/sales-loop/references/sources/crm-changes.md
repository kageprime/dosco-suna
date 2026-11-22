# Source: records that changed in the CRM

Trigger `sales-crm-changes` (cron, at :15 and :45 every hour, keyed session).
Disabled by default. It catches leads a person added by hand, imports, and
replies a person logged, so they get the same research and scoring as a
webhook lead.

## Cursor

The cursor is the newest `updated` time the previous run saw. Keep it in a
note on one bookkeeping record (the company record for the domain in
`company.website`), marker `[sales-loop] cursor`, body `cursor: <ISO time>`.
No cursor yet: start 24 hours back.

## Run

1. Check `sources.crm-changes.enabled`. Disabled: `errors=disabled`.
2. List people and companies created or updated since the cursor (the record
   reference's search with an updated-at filter), into a file. Drop records the
   agent itself changed (its own notes and fields are the only change).
3. For each record without a `researched` note younger than 30 days: run
   "One lead, end to end" (contract §5), under the caps.
4. For each record with a new inbound activity (a logged reply, an email the
   CRM synced) since its newest `drafted` marker: a `reply` draft, under the
   caps.
5. Write the new cursor last, after every other write succeeded.
6. End with the run line, slug `sales-crm-changes`.
