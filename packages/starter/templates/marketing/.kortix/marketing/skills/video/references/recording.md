# Record the feature

Record in the dev environment, in this sandbox, with synthetic data.

1. Load `dev-environment`. Install, start the app, seed the data the feature
   needs with synthetic values (`Acme Inc`, `jane@example.com`).
2. Plan the clip: the start state, then each step and its visible result.
   Each step is one clip of 3 to 10 seconds.
3. One browser session per video:

   ```sh
   S=marketing-video
   agent-browser --session $S set viewport 1920 1080
   agent-browser --session $S open http://localhost:<port>/<start page>
   # sign in with the synthetic user BEFORE recording starts
   agent-browser --session $S record start /tmp/marketing/video/<slug>/media/step-1.webm
   agent-browser --session $S click <ref>      # the real step
   agent-browser --session $S wait 1500        # let the result render
   agent-browser --session $S record stop
   ```

   Repeat `record start` / `record stop` per step (`step-2.webm`, …). Never
   record a sign-in page, a token, an email inbox or a settings page that
   shows a secret.
4. Check each clip: `ffprobe -v error -show_entries stream=codec_name,width,height:format=duration -of compact <clip>`.
   agent-browser 0.38.1 wrote VP8 WebM at 30 fps; HyperFrames 0.9.30 played it
   in a `<video>` element as is (tested 2026-11-10).
5. Trim dead time in the composition with `data-media-start` and
   `data-duration`, not with a re-encode.
6. Close the session: `agent-browser --session $S close`.
