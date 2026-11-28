---
recorded: 2026-11-24T18:08:51Z
incident_date: 2026-11-24
---
# Read the Kortix session of a request only through isProjectSessionPrincipal

**Rule:** `c.get('sessionId')` is not always a Kortix session: a person's Supabase JWT sets it to the AUTH session id (`auth-principal.ts`). A route that acts for a Kortix session reads it only when `isProjectSessionPrincipal(c)` is true (`middleware/agent-scope.ts`), and treats every other caller as a person.

**Trigger surface:** Writing a route that behaves differently for an agent session token, or that looks up `project_sessions` by the request's session id.

**Incident:** 2026-11-24, PR #13048, caught by flow `SEC-LOGIN-1` before merge. `POST /browser-logins/resolve` took a person's JWT for a session and answered `404 session_not_found` instead of `403 login_session_only`. The listing route would have filtered logins by a session that does not exist.

**Enforcement:** Flow `SEC-LOGIN-1` step "a person token, and another member's session, cannot spend it" asserts `403 login_session_only` for a person token.
