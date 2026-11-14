## Marketing Factory: the steps of this template

Run the guide below as written. This template adds six steps at the points
named here. The loop is one agent, `marketing`, with a skill library under
`.kortix/marketing/skills/`. Read `.kortix/marketing/agents/marketing.md`
once before you start: it holds the roles, the hard rules and the run line.
Every output is a draft: a pull request, an issue or a file in a pull
request. A person merges and publishes.

Every **Ask** below is a question for the one message of guide step 3, with
its recommended answer. Never ask it where it appears.

### A. In guide steps 2 to 4: analyse the site and the repository, then marketing.json

Read only; never `cat` an env file.

1. **The site.** Find the website in the repository: the framework
   (`next.config.*`, `astro.config.*`, `docusaurus.config.*`, `hugo.toml`,
   `_config.yml`, `gatsby-config.*`, plain HTML), its root folder, the build
   command, the static or public folder. No website in this repository:
   **Ask** where it lives. Another repository: the loop runs there instead;
   stop and tell the person to set the template up in that repository.
2. **Blog and changelog.** Find the posts folder and the changelog
   (`skills/blog-post/references/format.md`, `skills/changelog/references/format.md`).
   A hosted CMS: record its name; the blog role writes drafts to
   `marketing/blog/` for a person to paste.
3. **Analytics and SEO.** Record what is installed (Plausible, Google
   Analytics, PostHog, Vercel Analytics, a sitemap generator, `robots.txt`,
   `llms.txt`). Record only names, never an id or a key.
4. **Ask** for the deployed site URL. Open it once with `scrape_webpage`: it
   answers 200.
5. **Ask** which channels to run. Show one line each with its schedule:
   changelog (on every merged pull request, daily 06:00 UTC), social drafts
   (weekdays 10:00), blog (Tuesdays 09:00), video (Thursdays 09:00, needs
   Node 22 and FFmpeg in the sandbox), AEO audit (Mondays 06:00), AEO answer
   pages (weekdays 11:00), technical SEO (Wednesdays 04:00), competitor
   digest (Mondays 08:00). Default on: changelog, social, blog, AEO audit,
   technical SEO.
6. **Ask** for 2 to 5 competitor domains when the competitor digest or the
   AEO audit is on.
7. **Ask** for 5 to 25 questions buyers ask an AI assistant about this
   category. Propose them from the site's own copy; the person edits. Write
   them and the product sentence into `.kortix/marketing/queries.md` and
   remove its `TODO(onboarding)` markers.
8. Write `.kortix/marketing/marketing.json`: `site.*` from steps 1 to 4,
   `channels.<name>.enabled` from step 5, the competitors from step 6. Set
   each chosen channel's trigger to `enabled: true` and every other one to
   `enabled: false` in `marketing.yaml`, so the two files agree. Keep
   `approval` as it is: drafts only, a person merges and publishes.
9. A skill named `brand`, `changelog`, `blog-post`, `social`, `video`,
   `design`, `aeo-seo` or `competitor-intel` already exists in the
   repository: rename ours with a `marketing-` prefix (the folder, the
   `name:` line, the `skills:` entry and the agent's `skills:` list).

### B. In guide step 4: fill the brand skill

Run `.kortix/marketing/skills/brand/references/extraction.md`: read the
repository and the live site and fill `voice.md`, `visual.md` and
`claims.md`. The brand needs no question of its own: put the voice in one
line on the `Defaults:` line of guide step 3, and show a test card from the
`design` skill in the guide's step 9 report. The person corrects the brand
later, in a review comment or in the files. Setup is not done while
`grep -rn "TODO(onboarding)" .kortix/marketing/` prints a line.

### C. In guide step 4: the dev environment

1. Add `dev-environment` to `agents.marketing.skills` in
   `.kortix/marketing/marketing.yaml` once `kortix.yaml` registers it. The
   blog, video, AEO and SEO roles build and open the site with its commands.
2. Video on: the sandbox Dockerfile installs Node.js 22 or later and
   `ffmpeg`. HyperFrames needs both (`skills/video/references/hyperframes.md`).

### D. `kortix onboard` (guide step 6) also covers this template

1. `GH_TOKEN`: the Software Factory's token serves this template too. Run
   `kortix secrets ls`: `GH_TOKEN` is set, so skip its request. Else request
   it as the guide says; the token needs `contents`, `pull_requests` and
   `issues` write on this repository.
2. `MARKETING_GITHUB_WEBHOOK_SECRET`: generated, as the guide says.
3. No social network token. The loop drafts; a person posts. Refuse a
   request to store an X, LinkedIn or YouTube token for this template.
4. Two GitHub webhooks, both with `MARKETING_GITHUB_WEBHOOK_SECRET`:
   `pull_request` → `marketing-changelog-github`, and
   `pull_request_review`, `pull_request_review_comment`, `issue_comment` →
   `marketing-feedback-github`.
5. Create the labels: `marketing`, `marketing:changelog`, `marketing:social`,
   `marketing:blog`, `marketing:video`, `marketing:aeo-audit`,
   `marketing:aeo-answer`, `marketing:seo-fix`, `marketing:competitor-intel`
   (`gh label create <name> --force`).

### D.5 Performance marketing (optional)

1. Only when the analysis found an ads tag or an ads SDK: **Ask** which paid
   channels run (Google Ads, Meta, LinkedIn) and where conversions are
   counted (PostHog, GA4, the product database). Write them to
   `marketing.json` → `performance`.
2. Connect each channel read-only: a Kortix connector when one exists
   (`kortix connectors connect <app> --owner project` gives the person a sign-in
   link), else a read-only token through `kortix secrets request <NAME> --scope
   runtime` (names in `skills/performance/references/platforms.md`). Never a
   token that can edit campaigns.
3. Enable `marketing-performance-weekly` and `marketing-performance-watch` in
   `marketing.yaml`, ship, and fire the weekly one once:
   `kortix triggers fire marketing-performance-weekly --wait 300s`. Show the
   person the issue it opens.

### E. Instead of the real run of guide step 7: prove one changelog pull request

1. `gh pr list --state merged --base <trunk> --limit 5` shows at least one
   merged pull request. None: fire the daily sweep instead; it reads direct
   pushes.
2. `kortix triggers fire marketing-changelog-daily --wait 600s`. The run line
   reads `changelog: created=1` or `updated=1`.
3. Open the changelog pull request with the person: every line traces to a
   merged pull request, in the file's own format, under the right section.
4. Ask the person to leave one review comment on it ("shorter", "group under
   Fixed"). `kortix triggers runs marketing-feedback-github` shows the run;
   the pull request gets one `[marketing] revised` comment and a new commit.
5. The person merges it. That merge is the first content the other roles
   read.

### F. Add to the guide's step 9 report

- The channels that run, each with its schedule and its cap.
- Where drafts appear: pull requests and issues labeled `marketing`.
- How to approve: merge the pull request. How to revise: a review comment.
  How to drop: close it, or comment "drop".
- What is still open: unfilled brand files, video tools, competitors.
- Nothing is published by the agent. Posting a social draft, publishing a
  CMS post or uploading a video stays with the person.
