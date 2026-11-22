# Sizes

| Surface | Pixels | `image_gen` aspect_ratio |
|---|---|---|
| OG image, blog cover (unless the site's covers differ) | 1200×630 | `16:9`, then crop to 1.91:1 in the card |
| X post image | 1200×675 | `16:9` |
| LinkedIn post image | 1200×627 | `16:9`, then crop in the card |
| Square card | 1080×1080 | `1:1` |
| Vertical (story, short) | 1080×1920 | `9:16` |
| Video end card or thumbnail | 1920×1080 | `16:9` |

`image_gen` takes `auto`, `1:1`, `3:2`, `2:3`, `16:9`, `9:16`, `4:3` or
`3:4`. The card sets the final pixel size; the art fills it with
`object-fit: cover`.

A blog cover follows the site, not this table: measure the newest 3 covers
(`ffprobe` or `file`) and use their size.

Keep the words and the logo inside the middle 80 % of the width and height:
platforms crop the edges.
