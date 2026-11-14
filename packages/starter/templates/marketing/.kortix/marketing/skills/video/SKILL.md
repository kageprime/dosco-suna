---
name: video
description: Make one captioned, on-brand product video of a shipped feature - record the real feature in the dev environment with agent-browser, compose it with HyperFrames (HTML to video, by HeyGen, Apache-2.0), render a local MP4, check its frames, deliver it in a draft pull request. Load for the `video` role and whenever a person asks for a product video, a demo clip, a launch video or a walkthrough. Load `brand` first.
---

# Video

One feature, 20 to 60 seconds, the real product on screen, a caption per
step, the brand's fonts, colors and logo. Rendered on this machine; nothing
leaves the sandbox except the pull request.

## Steps

1. **Cap.** `caps.videos_per_week`: count `marketing:video` pull requests
   opened in the last 7 days. At the cap: end with `capped=1`.
2. **Pick.** The most user-visible change in the changelog of the last 7
   days that a person can see in a browser. Code-only changes get no video.
   Read its pull request; write the 3 to 6 steps a user takes.
3. **Prepare.** Check the tools once per session:
   `node --version` (22 or later), `ffmpeg -version`,
   `npx -y hyperframes@0.9.30 telemetry disable`,
   `npx -y hyperframes@0.9.30 doctor`,
   `npx -y hyperframes@0.9.30 browser ensure`. A missing Node 22 or FFmpeg:
   end with `errors=video-tools` and name it under `Needs a person` (the
   sandbox Dockerfile needs it).
4. **Record** the feature in the dev environment: `references/recording.md`.
5. **Compose.** `npx -y hyperframes@0.9.30 init <dir> --non-interactive --skip-skills --resolution landscape --example blank`,
   then replace `index.html` with `references/composition.html` and fill it
   as `references/hyperframes.md` says: brand values from `brand`, the clips,
   one caption per step, the logo on the end card.
6. **Check.** `npx -y hyperframes@0.9.30 lint` (0 errors) and
   `npx -y hyperframes@0.9.30 check --json` (`"ok": true`). Fix and repeat.
7. **Render.** `npx -y hyperframes@0.9.30 render --output out/<slug>.mp4`.
   Then `ffprobe` it: H.264, `channels.video` width and height, at most
   `channels.video.max_seconds`.
8. **Look.** Extract 4 frames (`references/hyperframes.md` has the command)
   and look at them. Reject on any item of the reject list in
   `brand/references/visual.md`, a blank frame, or a caption that does not
   match the screen. Render again.
9. **Deliver.** One draft pull request from `kortix/marketing-video-<slug>`:
   title `docs(video): <feature>`, labels `marketing` and `marketing:video`.
   Attach the MP4 and the frame sheet (`agents/marketing.md`, Media). Commit
   only `index.html` to `marketing/video/<slug>/index.html`, so a person can
   change a caption and render again; never the recordings, the font copies,
   `out/` or `node_modules`. The body lists the steps recorded and the
   commands run with their real output.

## Never

- `hyperframes publish`, `cloud`, `lambda`, `cloudrun` or `auth`: they upload
  the video or the project to a third party. Render locally only.
- Generated product UI, a real customer's data, a token or an email on
  screen.
- Music or a voice without the person's request in this pull request's
  thread.
