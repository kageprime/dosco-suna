---
name: design
description: Make on-brand graphics - blog covers, OG images, social cards, thumbnails - with the Kortix `image_gen` tool for the background art and an HTML card for the exact text and the real logo, rendered to PNG at the surface's native size. Load whenever a blog post, social draft, video or answer page needs an image, and whenever a person asks for a cover, an OG image or a social graphic. Load `brand` first.
---

# Design

The model draws the art. The words and the logo are composited after, from
real files, so they are always exact. Product UI is a real screenshot, never
generated.

## Steps

1. **Settle the surface**: the size from `references/sizes.md`, the exact
   words (at most 8 for a cover), and whether it shows product UI.
2. **Art** (skip when the card is type only or a screenshot):
   call `image_gen` with `action: "generate"`, 1 to 4 `prompts`, the
   `aspect_ratio` from the size table and `quality: "high"`. A prompt names
   the subject, the image direction of `brand/references/visual.md`, the
   brand colors as hex, the composition, and "no text, no logo". To match an
   existing cover, use `action: "edit"` with up to 5 `reference_images` from
   the repository. The tool saves to `/workspace/output/images/` and returns
   the paths. It allows 10 images per turn and 50 per session; this skill
   uses at most `caps.images_per_run`.
3. **Compose** the card in HTML with `references/card.md`: the art or the
   screenshot, the words in the brand font, the real logo file.
4. **Render** the card to PNG at the exact size with `agent-browser`
   (`references/card.md`), then a WebP for the web when the site serves WebP:
   `ffmpeg -i card.png -quality 80 card.webp`.
5. **Look** at the PNG. Reject it on any item of the reject list in
   `brand/references/visual.md`, or text that is cut, misspelled or
   unreadable at 25 % size. Fix and render again.
6. **Save** where the caller says: `site.media_path` for a blog cover, the
   drafts folder for a social card. Write alt text that says what the image
   shows.

## Never

- A generated logo, generated text inside the art, or generated product UI.
- A real person's face or name, a customer logo, a competitor's logo.
- A size that is not native to the surface: never upscale.
