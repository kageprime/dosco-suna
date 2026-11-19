---
recorded: 2026-11-19T10:35:00Z
incident_date: 2026-11-19
---
# Pair every upstream Platinum feature with a sovereign Dosco fallback before merging

**Rule:** Keep Platinum paths intact for future paid adoption, and ship a verified free or low-cost sovereign equivalent (E2B, Supabase Storage, OpenRouter, Groq/Inworld) for every upstream Platinum change before merging into `heroku-clean`.

**Trigger surface:** Pulling upstream (`kortix-ai/CompanyOS` / `kortix-ai/suna`), modifying `packages/llm-gateway/src/pipeline/audio.ts`, `apps/api/src/llm-gateway/`, `apps/api/src/platform/providers/`, `apps/api/src/drives/`, or toggling feature flags.

**Incident:** 2026-11-19, Heroku production `voice_call`. Enabling voice calls rang endlessly and never answered because upstream locked audio routes and voice fast-models to Platinum Inference, restored stale `KORTIX_FEATURE_FLAGS` on resumed E2B sandboxes, and lacked WebSocket connect and ready timeouts. Fixed with `Platinum -> Groq/Inworld -> OpenRouter` audio fallback (`hexgrad/kokoro-82m` + `openai/whisper-large-v3-turbo`), E2B wake flag refresh, and error surfacing.

**Enforcement:** `apps/api/src/platform/providers/dosco-sovereignty.test.ts` and the `Upstream Platinum-Delta Audit` in `AGENTS.md`.
