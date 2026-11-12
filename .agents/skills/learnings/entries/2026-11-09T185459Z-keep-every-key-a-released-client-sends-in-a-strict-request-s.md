---
recorded: 2026-11-09T18:54:59Z
incident_date: 2026-11-06
---
# Keep every key a released client sends in a strict request schema

**Rule:** Before you remove a key from a `.strict()` request schema in `@kortix/api-contract`, grep every released CLI tag for it in request bodies (`git grep -n "<key>" $(git tag -l 'v0.1*') -- apps/cli/src`). A strict schema refuses the whole request on one unknown key, so a key a shipped client still sends must stay as a deprecated alias. The schema already does this for `persistent_machine` and `require_connectors`.

**Trigger surface:** Renaming or removing a field of `SessionCreateInputSchema` or any other `.strict()` request body; a `feat!` cleanup of deprecated API names; writing the "old clients" section of a breaking-change PR.

**Incident:** 2026-11-06 to 2026-11-09. #11848 (v0.15.0) dropped `opencode_model` from `SessionCreateInputSchema`. CLI v0.13.0–v0.14.19 (75 release tags) sends `body.model = body.opencode_model = <id>`, so every `kortix sessions new --model` got `400 Validation failed` on prod for 3 days. #11848's old-CLI section listed read paths from code reading but not this create body. Fixed by #12152 (`dev`) and #12153 (`staging`, ships in v0.16.0).

**Enforcement:** `packages/api-contract/src/__tests__/schemas.test.ts` ("session create from an old CLI") parses the exact v0.14 body. TODO: a test that replays the request bodies of the oldest supported CLI tag against every strict schema.
