---
recorded: 2026-11-12T14:38:21Z
incident_date: 2026-11-12
---
# Keep Drive folder polling active after a refresh failure

**Rule:** Keep the folder refresh interval active after a failed read. Use the SDK query options in the explorer.

**Trigger surface:** An open Drive folder receives files from another client or a mounted session.

**Incident:** 2026-11-12: investigation of a stale Drive listing found that an error permanently stopped folder polling. The regression test returned false instead of the 10,000 ms refresh interval. Reloading created a new query and restarted polling.

**Enforcement:** packages/sdk/src/react/use-project-files.test.ts checks that a failed folder refresh retains its polling interval.
