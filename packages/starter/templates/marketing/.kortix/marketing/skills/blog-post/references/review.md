# Review before the pull request

Go through every line. Fix, then write `Checks: <n> items fixed` in the body.

- [ ] Every claim has its proof in `## Proof` (pull request, commit, docs URL,
      or a row of `brand/references/claims.md`).
- [ ] Every step was done in the real product in this run, with the exact
      labels it shows.
- [ ] No banned word from `brand/references/voice.md`; product terms spelled
      as the voice file spells them.
- [ ] No customer name, email, id or real data in text, code or screenshots.
- [ ] No price, no number without proof, no "first" or "only".
- [ ] Front matter matches the newest post key by key; the draft flag is set
      when the site has one.
- [ ] Title under 60 characters, description under 160.
- [ ] The site builds; the post renders; every image loads; no link returns
      4xx or 5xx (`curl -sIL` on each external link).
- [ ] Images have alt text that says what they show.
