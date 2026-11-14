---
name: brand
description: "The brand of this product, in files: the voice (how it writes), the visual system (logos, colors, fonts, image direction) and the claims it may make with their proof. Load it FIRST before any text or visual a reader outside the team sees: a blog post, a social post, a video, an image, an answer page. Onboarding fills it from the live site with the person; references/extraction.md is that procedure."
---

# Brand

This skill holds values only. The other skills hold procedures and point here.
When a request conflicts with these files, the files win: say so and offer the
closest on-brand option.

## Read before you write or draw

| Need | Read |
|---|---|
| Words: reader, tone, sentence rules, product terms, banned words | `references/voice.md` |
| Logos, colors, fonts, image direction, the reject list | `references/visual.md` |
| What the product may claim, and the proof for each | `references/claims.md` |
| Fill or refresh this skill from the site | `references/extraction.md` |

## Rules

1. A file that still holds `TODO(onboarding)` is not filled. `voice.md` or
   `visual.md` unfilled: stop every text or visual output and end the run
   with `errors=brand-unset`.
2. Use only the colors, fonts and logo files `visual.md` lists. Never redraw,
   recolor or generate a logo: composite the real file.
3. Make only the claims `claims.md` lists, or a new claim with a proof link
   you opened in this run. Put a new claim under `Needs a person` in the pull
   request, so a person adds it to `claims.md`.
4. Product UI in a visual is a real screenshot or recording of the product,
   never a generated picture of it.
5. Never change these files in a triggered run. A person changes them, or the
   onboarding agent with the person.
