---
recorded: 2026-11-10T14:57:52Z
incident_date: 2026-11-10
supersedes: 2026-11-06T140306Z-never-move-a-url-an-installed-desktop-shell-loads-behind-a-s.md
---
# Map a legacy path for the desktop shell inside the middleware's locale rewrite; a next.config rewrite never sees a path the middleware rewrote

**Rule:** Next runs `rewrites().beforeFiles` after the middleware, on the URL the middleware produced. The web middleware rewrites every signed-in page onto `app/[locale]` (`/projects/start` → `/en/projects/start`), so a `next.config` rewrite whose source is an unprefixed page path never matches. Serve a moved page to the `KortixDesktop` user agent in the middleware, where it builds the locale path (`pagePathname` in `apps/web/src/middleware.ts`). Prove a route move with a signed-in request against a production build, not a config-shape test. The 2026-11-06 rule (keep old paths for the shell, no 308) stands; its rewrite mechanism and its config-shape enforcer did not work.

**Trigger surface:** Moving a page route, adding a `next.config` rewrite for a page path, or changing the middleware's locale rewrite.

**Incident:** 2026-11-10, v0.15.3 (PR #11857): every signed-in desktop shell got a 404 on all `/projects/*` paths, including `/projects/start` at launch. 293 prod 404s in 24 h, ~13 h until the fix. Fixed by PR #12253.

**Enforcement:** `apps/web/src/middleware-desktop-legacy-paths.test.ts` asserts the middleware rewrite for a signed-in desktop request. Browser journey `27 — desktop parity (desktop) › a signed-in shell opens its legacy /projects paths in place` loads `/projects/<id>` and `/projects/start` in the release suite.
