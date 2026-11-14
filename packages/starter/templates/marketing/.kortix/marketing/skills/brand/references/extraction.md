# Fill the brand skill from the site

The onboarding agent runs this once during setup, and again when the site's
look changes. A triggered run never runs it. It asks the person nothing:
during setup, the voice is one entry on the `Defaults:` line of the guide's
one message of questions.

## 1. Read what exists

Read only. Never print an env file.

1. In the repository:
   - brand or design folders: `brand/`, `design/`, `.agents/skills/*brand*`,
     `.claude/skills/*brand*`, a voice or style guide;
   - logo files: `*logo*.svg`, `*logo*.png`, `favicon.*`,
     `apple-touch-icon.*`, under `public/`, `static/` or `assets/`;
   - theme files: `tailwind.config.*`, `globals.css`, `theme.*`,
     `tokens.json`, CSS custom properties such as `--color-*`;
   - fonts: `@font-face`, `next/font`, Google Fonts links;
   - the newest 3 blog posts and the newest changelog entries.
2. On the live site (`site.url`), open the home page, one blog post and the
   pricing or product page. Use `scrape_webpage`, or `agent-browser` when the
   page needs JavaScript. Record:
   - the `<title>`, the meta description and the `og:image`;
   - the computed colors of the body, the headings and the primary button,
     and the font families (`agent-browser eval` with `getComputedStyle`).
3. A brand skill or voice guide already in the repository: reuse it. Point
   `marketing.json` `brand.*` at those files instead of copying them.

## 2. Fill the files

- `visual.md`: logos with real paths, colors with their source token, fonts
  with their source, the image direction from 2 existing images.
- `voice.md`: the reader, the tone from 3 passages of the site, the product
  terms as the site spells them, the banned list. When the person corrects
  the voice, write their words in, word for word.
- `claims.md`: 5 to 20 rows, each with a proof URL you opened.
- `marketing.json` `brand.logos` and `brand.fonts`: the same paths.

## 3. Prove it

1. Render one test card with the `design` skill: 1200×630, the product name
   on the brand background, the real logo.
2. Show it to the person (during setup: in the final report). A correction
   they send later goes into the files.
3. Remove every marker: `grep -rn "TODO(onboarding)" .kortix/marketing/`
   prints nothing.
