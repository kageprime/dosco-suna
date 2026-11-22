# The HTML card

Write `/tmp/marketing/design/<slug>/card.html`. Copy the art, the logo and
the brand font into the same folder, so every path is local.

```html
<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  @font-face { font-family: "Brand"; src: url("brand-font.woff2"); }
  html, body { margin: 0; width: 1200px; height: 630px; overflow: hidden; }
  body { position: relative; background: #0b0b0c; color: #ffffff; font-family: "Brand", sans-serif; }
  .art { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
  .scrim { position: absolute; inset: 0; background: linear-gradient(90deg, rgba(0,0,0,.65), rgba(0,0,0,0) 70%); }
  h1 { position: absolute; left: 96px; top: 200px; width: 640px; margin: 0; font-size: 64px; line-height: 1.05; font-weight: 600; }
  .logo { position: absolute; left: 96px; bottom: 80px; height: 44px; }
</style>
</head>
<body>
  <img class="art" src="art.png" alt="" />
  <div class="scrim"></div>
  <h1>Export reports as CSV</h1>
  <img class="logo" src="logo.svg" alt="" />
</body>
</html>
```

Replace the colors, the font file and the sizes with the values of
`brand/references/visual.md` and `sizes.md`. Drop `.art` and `.scrim` for a
type-only card. For product UI, the `.art` image is a real screenshot taken
with `agent-browser screenshot` from the dev environment.

## Render

```sh
S=marketing-design
agent-browser --session $S set viewport 1200 630
agent-browser --session $S open file:///tmp/marketing/design/<slug>/card.html
agent-browser --session $S wait 500
agent-browser --session $S screenshot /tmp/marketing/design/<slug>/card.png
agent-browser --session $S close
```

Check the size: `ffprobe -v error -show_entries stream=width,height -of csv=p=0 card.png`
prints `1200,630`. A different size (a device scale factor): set the
viewport again or scale with `ffmpeg -i card.png -vf scale=1200:630 out.png`
only when the ratio is the same.
