---
name: aeo-seo
description: Make the site findable by search engines and AI assistants. Three procedures - a weekly visibility audit of the tracked buyer questions (who gets cited, where the site is missing) as one issue; an answer page that closes the biggest gap as one pull request; a technical SEO crawl that fixes broken links, metadata, canonicals, sitemaps, robots rules and JSON-LD in code. Load for the `aeo-audit`, `aeo-answer` and `seo-fix` roles, and whenever a person asks about SEO, AEO, GEO, llms.txt, rankings or AI citations.
---

# AEO and SEO

Measure first, write second, and fix only what you can prove is broken.
Search results and AI answers change by place and by day: one run is a
sample, never a ranking.

| Role | Reference | Output |
|---|---|---|
| `aeo-audit` | `references/audit.md` | one issue `[marketing] AEO audit <date>`, label `marketing:aeo-audit` |
| `aeo-answer` | `references/answer-page.md` | one pull request, label `marketing:aeo-answer` |
| `seo-fix` | `references/technical-seo.md` | one pull request, label `marketing:seo-fix`; an issue for what code cannot fix |

## Inputs

- `site.url`: the deployed site. `null`: end with `errors=no-site-url`.
- `.kortix/marketing/queries.md`: the tracked questions. Still holds
  `TODO(onboarding)`: end `aeo-audit` with `errors=queries-unset`.
- `channels.competitor-intel.competitors`: the competitor domains.
- Tools: `web_search` and `scrape_webpage` (Kortix tools), `curl`,
  `agent-browser` for pages that need JavaScript, and Lighthouse through
  `npx lighthouse` when it installs.

## Rules

- Record only what a tool returned, with the date. Never answer a tracked
  question yourself and record it as an assistant's answer: no tool for an
  assistant means `not measured`.
- An answer page states only facts from the repository, the live site or a
  public source it links (`brand` rule 3).
- A fix changes the cause (the layout, the template, the config), not page by
  page. Never change a page's visible copy in `seo-fix`.
