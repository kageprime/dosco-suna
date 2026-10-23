---
recorded: 2026-10-23T22:47:16Z
incident_date: 2026-10-23
---
# Check the product host resolvers before deleting a wildcard under the product domain

**Rule:** Before deleting a wildcard DNS record under a product domain, check the product's host resolvers and the deployment config that names it. A wildcard is a product surface when a resolver hands out hosts beneath it.

**Trigger surface:** Auditing DNS, cleaning up unused domains, or changing `KORTIX_APPS_BASE_DOMAIN` / `KORTIX_PREVIEW_BASE_DOMAIN`.

**Incident:** 2026-10-23, `dosco.live`. The runbook said `*.apps` and `*.preview` were unused and safe to delete. Both pointed at Vercel and served the marketing site. `appsBaseDomain()` already derived `apps.dosco.live` from `KORTIX_URL`, so the API handed out `prod-<slug>-<route-key>.apps.dosco.live` URLs; `previewBaseDomain()` needed `KORTIX_PREVIEW_BASE_DOMAIN` to move previews off the path proxy. Deleting the wildcards would have removed the only DNS path for both surfaces. Fixed by adding Heroku wildcard domains, ACM certs, and direct-edge config; no customer data was affected.

**Enforcement:** none yet: add a deployment check that every wildcard referenced by `appsBaseDomain()` / `previewBaseDomain()` exists in `heroku domains` and resolves to the API edge, and a runbook check that the DNS inventory lists the product wildcards.
