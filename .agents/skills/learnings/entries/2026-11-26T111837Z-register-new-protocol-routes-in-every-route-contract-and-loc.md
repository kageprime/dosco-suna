---
recorded: 2026-11-26T11:18:37Z
incident_date: 2026-11-26
---
# Register new protocol routes in every route contract and localize shared question controls

**Rule:** A new protocol route needs its audit label, OpenAPI operation, credential-fence binding and request-timer classification in the same commit. Shared UI strings need every release locale and the bundled fallback catalog.

**Trigger surface:** Adding an externally authenticated streaming endpoint or shared question controls.

**Incident:** 2026-11-26, KRTX-5154. Nightly Tests had four failing lanes: route contracts, shared-question localization, a tool-knowledge script crossing the daemon boundary, and a release-script fetch type. A child-output test also accepted an empty file before its write completed.

**Enforcement:** Existing audit-route, OpenAPI, workspace-binding and worker-scope tests; strict i18n audit; question-prompt host-locale regression; package-boundary test; mobile typecheck. Keep the original checks enabled.
