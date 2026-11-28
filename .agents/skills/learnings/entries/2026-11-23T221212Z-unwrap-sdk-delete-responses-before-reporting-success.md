---
recorded: 2026-11-23T22:12:12Z
incident_date: 2026-11-23
---
# Unwrap SDK DELETE responses before reporting success

**Rule:** Call unwrap on backendApi DELETE responses so HTTP failures reject the promise.

**Trigger surface:** Adding a DELETE operation to the published SDK.

**Incident:** 2026-11-24: review reproduced a 403 from gallery-folder deletion resolving successfully. The UI could display a deletion toast while the folder remained. This was caught before merge.

**Enforcement:** packages/sdk/src/core/rest/projects-client/artifact-folders.test.ts asserts that a 403 rejects. The test failed before unwrap and passes after it.
