# Technical SEO crawl (`seo-fix`)

1. **Cap.** `caps.seo_pull_requests_open`: open `marketing:seo-fix` pull
   requests. At the cap: end with `capped=1`.
2. **Crawl** `site.url`: read `/robots.txt` and `/sitemap.xml`, then follow
   internal links up to `channels.seo-fix.max_pages` pages. `curl -sIL` for
   status codes; `curl -s` or `scrape_webpage` for the HTML.
3. **Record** each defect with its URL and the evidence:
   - a link that returns 4xx or 5xx, or a redirect chain over 2 hops;
   - a missing, duplicate or empty `<title>`, meta description or `<h1>`;
   - a missing canonical, or one that points to another host;
   - a sitemap URL that returns non-200; a linked page missing from the
     sitemap;
   - `robots.txt` that blocks a sitemap page, or blocks `Googlebot`,
     `Bingbot`, `GPTBot`, `ClaudeBot` or `PerplexityBot` with no comment that
     says why;
   - JSON-LD that does not parse;
   - an image without `alt`, or an image over 500 KB.
4. **Lighthouse**, when it runs:
   `npx lighthouse <url> --only-categories=performance,seo --output=json --chrome-flags=--headless`
   on the home page and the 3 most linked pages. Record LCP, CLS and the SEO
   score. Compare with the previous `marketing:seo-fix` pull request's body.
   A regression is LCP 20 % worse or more, or CLS above 0.1.
5. **Skip** a defect an open issue or pull request already covers.
6. **Fix** the cause in the template, layout or config. Build, start, and
   check every fixed URL locally: status, title, meta, canonical.
7. **Open** one pull request from `kortix/marketing-seo-<date>`: each
   defect, its URL, the evidence, the fix, the local check.
8. A defect code cannot fix (a server redirect, a CDN rule, DNS): one issue
   with the evidence, label `marketing:seo-fix`. No defect: no pull request;
   the run line says how many pages you crawled.
