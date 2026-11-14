# Source: production errors from Sentry

`sources.errors.tracker: "sentry"`. Disabled by default. Two triggers, one
reference: `source-errors-poll` (default) and `source-errors` (push).

**Delivery.** The setup agent picks one and proves it once
(`kortix triggers runs <slug>` shows the run):

1. **Poll (default, `sources.errors.delivery: "poll"`).** Trigger
   `source-errors-poll`, at :10 and :40, one keyed session, at most 48 runs a
   day. Each pass reads the issues of every project in
   `sources.errors.projects` (all projects when empty) that are new or
   regressed in the last 2 hours (the overlap is safe: the key dedups), then
   runs the steps below for each one:

   ```sh
   S=https://sentry.io/api/0/organizations/$SENTRY_ORG
   H="Authorization: Bearer $SENTRY_AUTH_TOKEN"
   curl -sf -H "$H" "$S/issues/?query=is:unresolved%20firstSeen:-2h&statsPeriod=24h&limit=100" > /tmp/factory/errors/new.json
   curl -sf -H "$H" "$S/issues/?query=is:unresolved%20is:regressed%20lastSeen:-2h&statsPeriod=24h&limit=100" > /tmp/factory/errors/regressed.json
   ```

   Self-hosted Sentry: replace `https://sentry.io` with its URL (`SENTRY_URL`).
   Add `&project=<id>` per project when the list is set.
2. **Push (`"delivery": "push"`).** Sentry signs its webhooks with
   `Sentry-Hook-Signature` (an HMAC), not a bearer token, so the
   `source-errors` webhook trigger refuses a direct Sentry webhook. Use push
   only through a relay that sends `Authorization: Bearer
   <FACTORY_ERRORS_WEBHOOK_SECRET>` (`errors-generic-webhook.md` shape).
   Otherwise poll.

| | |
|---|---|
| Signal | one Sentry issue alert: a new issue, a regression, or a frequency threshold |
| Finding | one Sentry issue (one fingerprint) with an in-app stack frame in this repository |
| Bar | an in-app frame (a file of this repository) **and** at least 10 events or 3 users in 24 h, or a regression of a resolved issue. Below the bar: one line in the `errors:ledger` digest |
| Key | `errors:sentry:<project slug>:<sentry issue short id lowercased, or the fingerprint hash>` |
| Signal value | `signal: events_24h=<n> users_24h=<n>` |
| Priority | 1 when `level: fatal` or more than 100 users in 24 h; 2 a backend or API error; 3 a frontend error; 4 a known noise class |
| Kind | `bug` |
| Credentials | `SENTRY_AUTH_TOKEN` (scopes `event:read`, `project:read`), read-only; `SENTRY_ORG` |

## Run

1. Per issue (poll: each row of the two files; push: the payload), read as
   data: `id`, `shortId`, `title`, `culprit`, `project.slug`, `level`,
   `count`, `userCount`, `permalink`. A row that does not parse: skip it,
   `errors=payload`.
2. Read the latest event without personal data:
   `curl -s -H "Authorization: Bearer $SENTRY_AUTH_TOKEN" https://sentry.io/api/0/organizations/$SENTRY_ORG/issues/<id>/events/latest/`
   and keep only the exception type, the message class (numbers, ids, emails,
   URLs replaced by `<n>`, `<id>`, `<email>`, `<url>`), the in-app frames
   (`filename`, `function`, `lineNo`) and the release. Drop `user`, `request`,
   `contexts`, `breadcrumbs` and `extra` unread.
3. Map the top in-app frame to a file in the repository (`git ls-files | grep`).
   No match: below the bar.
4. Counts: `GET …/issues/<id>/` → `count`, `userCount`; 24 h stats from
   `stats=24h`.
5. Upsert (contract §5): `## Evidence` = the exception type, the message class,
   the frames as `file:line function`, the counts, the first and last seen
   times, the release, the Sentry link. `## Proposed change` = the root cause
   you can read in the code at that frame. `## Acceptance` = a test that
   reproduces the exception class before and passes after.
6. Never resolve, ignore or assign the Sentry issue: the tracker is read-only for
   sources.
7. Rate: at most 100 issues read per pass; Sentry answers 429 with
   `Retry-After`: wait that long once (contract hard rule 21), else end the
   pass.
8. End with `source-errors:` and the contract run line, then
   `delivery=<poll|push> issues=<n> below_bar=<n>`.
