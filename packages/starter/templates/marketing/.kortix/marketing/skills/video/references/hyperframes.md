# HyperFrames: what this skill relies on

HyperFrames turns an HTML page with timed elements into a video. It seeks
the page frame by frame in headless Chrome and encodes the frames with
FFmpeg.

## Facts and sources

| Fact | Source |
|---|---|
| Repository `heygen-com/hyperframes`, by HeyGen, license Apache-2.0 | https://github.com/heygen-com/hyperframes |
| npm package `hyperframes` (the CLI), version 0.9.30 on 2026-11-10, `engines.node >=22` | https://www.npmjs.com/package/hyperframes (`npm view hyperframes`) |
| Requirements: Node.js 22+, FFmpeg; Chrome via `hyperframes browser ensure` | https://github.com/heygen-com/hyperframes/blob/main/README.md, https://hyperframes.heygen.com/packages/cli |
| Commands `init`, `preview`, `lint`, `check`, `render`, `transcribe`, `doctor`, `browser` | https://hyperframes.heygen.com/packages/cli |
| `render` formats: mp4 (default), webm, mov, gif, png-sequence, hls; `--quality draft\|looks\|standard\|high\|delivery`; `--fps` 1 to 240 | https://hyperframes.heygen.com/guides/rendering |
| Root needs `data-composition-id`, `data-width`, `data-height`, `data-start="0"`; each timed element needs `id`, `data-start`, `data-duration` | https://hyperframes.heygen.com/reference/html-schema, https://hyperframes.heygen.com/concepts/data-attributes |
| Animation: one GSAP timeline created `{ paused: true }`, registered as `window.__timelines["<composition-id>"]`; no wall clock, no unseeded randomness, no infinite repeat | https://hyperframes.heygen.com/reference/html-schema, https://hyperframes.heygen.com/concepts/determinism |
| Media: plain `<video>`, `<audio>`, `<img>`; `data-media-start` trims; silent footage needs `muted`; never call `play()` or set `currentTime` | https://hyperframes.heygen.com/concepts/data-attributes |
| Captions from speech: `hyperframes transcribe` writes word timings (whisper.cpp or Parakeet, local) | https://hyperframes.heygen.com/guides/captions-and-recuts |
| Exact reproducibility across machines needs `render --docker` | https://hyperframes.heygen.com/concepts/determinism |
| Telemetry is on by default; `hyperframes telemetry disable` turns it off | `npx hyperframes@0.9.30 --help`, `telemetry --help` (run 2026-11-10) |
| `publish` uploads to hyperframes.studio; `cloud` renders on HeyGen's servers | `npx hyperframes@0.9.30 --help` (run 2026-11-10) |

## Verified on 2026-11-10 (Linux, Node 22.23, FFmpeg 8.0.1)

`init` → replace `index.html` with `composition.html` → `lint` (0 errors,
0 warnings) → `check --json` (`"ok": true`) → `render --output out/promo.mp4`.
Result: H.264, yuv420p, 1920×1080, 30 fps, 10.0 s, 494 KB, rendered in 22 s.
The frames showed the agent-browser WebM clip, a local TTF brand font, an SVG
logo and both captions. Nesting text inside a timed `<section>` gives the lint
warning `nested_structure_needs_subcomposition`; keep timed elements flat, as
`composition.html` does.

## Fill composition.html

1. `:root` variables: `--ground`, `--ink`, `--muted` from the brand colors;
   `@font-face` points at the brand font file copied into `fonts/` (a local
   file renders the same every time; a web font link may not).
2. Intro (0 to 2 s): the outcome in the title, under 6 words.
3. One `<video>` per recorded step, back to back. Each step's caption is a
   `<p class="caption clip">` that starts 0.2 s after its clip and ends with
   it. A caption is one short sentence: the action and its result.
4. End card (3 s): the real logo file from `brand/references/visual.md`, the
   site URL, one call to action.
5. Set the root `data-duration` to the end of the last element.
6. Every animated element is in the timeline with a fixed start time.

Captions here are on-screen text written from the steps. Use
`hyperframes transcribe` only when the video has a voice track.

## Frame check

```sh
ffmpeg -v error -y -i out/<slug>.mp4 \
  -vf "select='eq(n\,30)+eq(n\,90)+eq(n\,165)+eq(n\,240)',scale=640:-1,tile=2x2" \
  -frames:v 1 -fps_mode vfr out/<slug>-frames.png
```

Pick frame numbers inside the intro, two steps and the end card
(frame = seconds × fps). Open the PNG and look at it.

## Not verified

- A render inside a Kortix sandbox image: the test ran on a Linux dev box.
  Chrome Headless Shell downloads on `browser ensure` (261 MB on disk) and needs
  outbound network once.
- H.264 MP4 input clips: only VP8 WebM from agent-browser was tested.
- Audio, `transcribe`, `--docker` and the `mov`/`webm` transparent formats.
- The `@hyperframes/*` scoped packages: this skill uses only the `hyperframes` CLI.
