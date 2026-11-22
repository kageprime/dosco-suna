---
recorded: 2026-11-18T22:36:31Z
incident_date: 2026-11-18
---
# Return canonical browser links for change requests instead of REST resource paths

**Rule:** Return the canonical Review browser link from CR commands. Never infer a browser page from a REST resource path. Keep shared historic paths as scoped compatibility routes.

**Trigger surface:** Change-request CLI output, agent instructions, and workspace browser routes.

**Incident:** 2026-11-18, KRTX-4976: a shared `/workspaces/<workspace_id>/change-requests/<cr_id>` link returned 404 because only the REST API served that shape. A server redirect also lost browser fragments during local verification; client replacement preserves them.

**Enforcement:** `change-request-links.test.ts`, CLI `cr-parity.test.ts`, the compatibility `page.test.ts`, and `change-request-link.test.tsx` cover canonical selection, scoped numeric resolution, query and fragment preservation.
