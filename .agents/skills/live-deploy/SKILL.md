---
name: live-deploy
description: "Runbook for the live dosco.live deployment: Heroku (api.dosco.live, container stack, releases, config vars, custom domain, ACM) and Vercel (the dosco web project, domains, env targets, manual production redeploys), plus the Name.com DNS records that tie them together. Load this WHENEVER you deploy dosco outside the repo's dev/staging/prod topology, change anything about api.dosco.live or dosco.live or www.dosco.live, touch name.com DNS, rotate Heroku/Vercel tokens or env vars, pin or eye a production release on the Heroku app, or debug the web-to-backend base-URL contract (NEXT_PUBLIC_BACKEND_URL / KORTIX_URL) on the live site."
---

# Live dosco deployment (Heroku + Vercel)

The full runbook lives in [`references/deployment-heroku-vercel.md`](references/deployment-heroku-vercel.md).
It carries the live status table (domains, releases, DNS record set with editor
and TTL), the deploy and redeploy commands, the env-var contract between web and
API, the verification steps after every deploy, and the current pending items.
