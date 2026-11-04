---
recorded: 2026-11-04T08:35:00Z
incident_date: 2026-11-04
---
# An upstream merge must never drop Dosco-specific providers (E2B) or replace decoupled interfaces with Platinum-only gates

**Rule:** An upstream sync must never delete, deprecate, or strip Dosco's sovereign providers or interfaces (`apps/api/src/platform/providers/e2b.ts`, `apps/api/src/snapshots/providers/e2b.ts`, `apps/api/src/drives/storage/`, or `Dockerfile.heroku`). Decoupled feature gates must check `driveStorageAvailable()`, never upstream's `isPlatinumConfigured()`.

**Trigger surface:** Merging upstream trunk (`kortix-ai/CompanyOS`), touching `apps/api/src/config.ts`, `apps/api/src/platform/providers/`, `apps/api/src/drives/`, or deploying to Heroku.

**Incident:** 2026-11-04, Heroku production. Following an upstream merge (`7d39231cb8`), dynos crashed with `H10 App crashed` (`503 Service Unavailable`). Upstream commit `08a64413b3` had removed E2B support from `KNOWN_PROVIDERS` and deleted `e2b.ts` in favor of Platinum-only microVMs. On Heroku (which has no Docker-in-Docker or Platinum credentials), `ALLOWED_SANDBOX_PROVIDERS=e2b` failed validation, fell back to `['platinum']`, and crashed on boot due to missing `PLATINUM_API_KEY`. Fixed by restoring E2B provider files, domain resolution, snapshot adapters, compute rate cards, and environment schema validation (`a022d124e8`).

**Enforcement:** `apps/api/src/platform/providers/dosco-sovereignty.test.ts` asserts that `KNOWN_PROVIDERS` includes `'e2b'`, all E2B provider and snapshot adapter files exist on disk, Supabase storage provider files exist, `driveStorageAvailable()` is implemented, and `Dockerfile.heroku` specifies `SANDBOX_AGENT_BUN_VERSION=1.4.3`.
