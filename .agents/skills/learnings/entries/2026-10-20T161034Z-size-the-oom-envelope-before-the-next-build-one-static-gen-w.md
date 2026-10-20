---
recorded: 2026-10-20T16:10:34Z
incident_date: 2026-10-20
---
# size the oom envelope before the next build: one static-gen worker and an explicit node heap are build-machine knobs, not defaults

**Rule:** Before a push whose build generates hundreds of static pages, set the OOM envelope explicitly for the build machine: `staticGenerationMaxConcurrency` at the worker's real budget and `NODE_OPTIONS=--max-old-space-size` for the build command. The dev box never proves the envelope: the build container is a separate machine (2 cores / 8 GB on a Vercel Hobby plan) whose memory the Next default worker split can exceed.

**Trigger surface:** Configuring `next build` for a deploy platform (vercel.json), or touching anything that grows the static surface (new pages, `generateStaticParams`, marketing content).

**Incident:** 2026-10-20, the landing redesign on `main`. First production build died with the Next static-generation worker SIGKILLed at page ~200 of 954 (container OOM, no error in the page itself). Warm-cache rebuild passed clean, so the true constraint stayed hidden until the second push: the Hobby build-cache cap killed the cache, the next build ran cold, and the generation phase hit its resident-set ceiling at page ~954 with `next build` killed at +99 s. Cold cache raises the generation-phase baseline memory enough to cross the container limit even though the same commit passes warm. Fix (commit `bcdf742425`): `staticGenerationMaxConcurrency: 1` plus `NODE_OPTIONS=--max-old-space-size=3584 next build` in `apps/web/vercel.json` — the parent and the single worker then fit in the 8 GB container (runtime is untouched; build-time only). Proof: the next cold build finished all 954 pages in 84 s, faster than the earlier warm 96 s run, and the ~9 min build went READY. `staticGenerationMinPagesPerWorker: 250` keeps Next from spawning a second worker under the new concurrency.

**Enforcement:** none yet: a build-envelope check that sizes concurrency and heap against the deploy machine's memory before a push. Until then the measures are the vercel.json envelope comment and the build log's `Generating static pages` line: a first-push build must show a flat worker count and finish the generation phase without a worker kill.
