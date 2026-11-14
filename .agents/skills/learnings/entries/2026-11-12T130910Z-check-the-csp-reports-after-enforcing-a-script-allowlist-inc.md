---
recorded: 2026-11-12T13:09:10Z
incident_date: 2026-10-23
---
# Check the CSP reports after enforcing a script allowlist, including scripts that load late

**Rule:** When `script-src` in `apps/web/src/lib/security/content-security-policy.ts` changes, open every flow that loads a script on demand: modals, embeds, and vendor scripts that load other vendors. Read the `[csp-report]` lines in the Vercel runtime logs for the week after the release. A host that a page needs and the allowlist misses fails silently for the user. The only trace is one warning line.

**Trigger surface:** editing the CSP allowlist, adding a third-party script or embed to `apps/web`, or making a report-only policy enforced.

**Incident:** v0.14.7 (2026-10-23) enforced `script-src`. The demo modal loads `app.cal.com/embed/embed.js` only when it opens, and that host was not on the list. For 3 weeks, a qualified lead saw an empty "Pick a time" step. The block showed as 6 warnings among ~7,100 noise warnings per day, and nobody read them. Fixed in PR #12568.

**Enforcement:** none automated. The detector is the `[csp-report]` warning in the Vercel runtime logs (`/api/csp-report`). TODO: alert on a `[csp-report]` line whose blocked origin has not been seen before. PR #12568 removed the noise sources, so one new origin now stands out.
