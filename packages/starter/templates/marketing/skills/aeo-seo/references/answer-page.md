# Answer page (`aeo-answer`)

1. **Cap.** `caps.aeo_pages_per_week`: count `marketing:aeo-answer` pull
   requests opened in the last 7 days. At the cap: end with `capped=1`.
2. **Gap.** Read `## Gaps` of the newest `marketing:aeo-audit` issue. None:
   end with `errors=no-audit`. Take the first gap that no open or merged
   `marketing:aeo-answer` pull request covers
   (`gh pr list --label marketing:aeo-answer --state all --search "<question>"`).
3. **Place.** Find how the site adds pages (framework, content folder, the
   style of existing pages). Update the existing page closest to the question;
   create a new page only when none fits.
4. **Facts.** Collect them before you write. Each claim comes from the
   repository (code, docs, README, changelog, config), a page of `site.url`,
   or a public page you opened and link. A missing fact stays out and goes
   under `Needs a person`.
5. **Write** (brand voice):
   - the answer in the first 2 sentences, in plain words;
   - a heading in the buyer's words from the question;
   - an FAQ section for related questions you can answer from step 4;
   - schema.org JSON-LD that matches the visible text exactly;
   - a title under 60 characters and a meta description under 160;
   - 2 to 5 internal links from and to related pages;
   - a canonical URL, set the way the site sets it.
6. **llms.txt.** Update `site.llms_txt_path` (default `/llms.txt` in the
   site's static folder): one line per important page, a title and a
   one-line description, per the format at https://llmstxt.org/.
7. **Build and look.** Build, start, open the page with `agent-browser`: it
   renders, the JSON-LD parses (`JSON.parse` on every
   `script[type="application/ld+json"]`), no link returns 4xx or 5xx.
8. **Open** the pull request from `kortix/marketing-aeo-<slug>`: the
   question, the audit issue and its status, what changed, the proof of each
   claim, the checks, `Needs a person`.
