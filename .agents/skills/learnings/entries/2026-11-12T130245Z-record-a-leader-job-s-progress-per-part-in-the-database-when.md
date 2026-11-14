---
recorded: 2026-11-12T13:02:45Z
incident_date: 2026-11-11
---
# Record a leader job's progress per part in the database when one unit of its work can outlast the worker; a restart continues, never starts the unit over

**Rule:** When one unit of a leader job (a week, an account, a file) can run longer than the worker lives (prod worker: hours; deploys and kills restart it), record progress per part in the database as each part is durably done, and let a restart continue after the last recorded part. Read expensive inputs (a tally, a listing) once per unit and save them. Stop at the pass budget between parts and run the next pass soon, not at the next daily tick. Parts written to write-once storage keep the same boundaries and bytes across restarts. This repeats the cursor rule of the 2026-10-17 entry for a unit that is itself longer than the worker's life.

**Trigger surface:** writing or reviewing a `leaderTimer` job whose single unit can take more than ~30 min (`worker/jobs/*`, `shared/audit-archive/`), or a job log that shows the same unit starting again after each worker restart.

**Incident:** 2026-11-11 to 2026-11-12, prod. The audit archive restarted legacy week 2026-08-17 (~50M rows) at every worker restart: ~2 h 50 min of tally at the 5,000 rows/s cap, then the export, and the worker died after ~3.5 h (zombie crash, then a probable memory kill). 979 MB of that week reached S3, no week was archived after 05:34Z on 11-11, and the 213 GB legacy table could not be retired. Each 100,000-row part also held its lines as text and gzipped them in one call: ~1.4 GB peak RSS against ~0.3 GB streamed (local A/B, 250k rows). Fixed in PR #12571: `audit_archive_chunks.legacy_tally` and `audit_archive_parts` record the tally and every verified object, the pass stops at its budget and continues 60 s later, and parts stream through `RowEncoder`, whose bytes equal `encodeRows`.

**Enforcement:** `apps/api/src/shared/audit-archive/archive.integration.test.ts` ("an export stopped mid-week resumes after its last recorded part…", "…reaches its deadline…", "a pass that runs out of budget mid-week reports pending…") fails when a restart reads the tally or a finished part again, or when a resumed week's objects or manifest differ from an uninterrupted export. `format.test.ts` fails when `RowEncoder` bytes differ from `encodeRows`. Not enforced: other leader jobs; there is no generic check that a job's unit fits the worker's life.
