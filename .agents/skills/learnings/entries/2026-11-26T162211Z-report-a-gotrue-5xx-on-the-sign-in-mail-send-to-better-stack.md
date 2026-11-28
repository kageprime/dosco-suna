---
recorded: 2026-11-26T16:22:11Z
incident_date: 2026-10-30
---
# Report a GoTrue 5xx on the sign-in mail send to Better Stack and answer 503, never a silent 400

**Rule:** When GoTrue answers 5xx to a sign-in or sign-up mail send, `sendEmailCode`
reports `[auth] email send failed` to Sentry (Better Stack) at error level, with the
GoTrue code and status as tags and never the address, and the route answers 503.
A 5xx is the mail path failing, not a bad address.

**Trigger surface:** Any change to `sendEmailCode` in
`apps/web/src/app/[locale]/(auth)/auth/actions.ts`, to `POST /api/auth/send-code`, or to
the SMTP relay in the Supabase Auth settings.

**Incident:** 2026-10-30 05:00 to 15:00 UTC, production. Prod GoTrue sends through the
Supabase SMTP relay `smtp.resend.com` (verified 2026-11-26 through the Management API).
The Resend monthly quota was spent (see the 2026-10-30 bulk-mail entry), so 39 sends
failed with `550 You have reached your monthly email sending quota`. The route turned
every failure into a 400 and logged nothing, so only a synthetic signup noticed
(KRTX-3753). The quota reset on 2026-11-01. A quota outage recurs on the same relay
whenever the month's mail volume reaches the plan limit.

**Enforcement:** `apps/web/src/app/[locale]/(auth)/auth/send-email-code.test.ts`, the
KRTX-3753 tests: a 500 delivery failure must answer 503 and call `captureMessage`, also
on a closed-signup deployment; a 400 must not.
