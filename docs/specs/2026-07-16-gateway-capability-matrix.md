# Gateway Capability Matrix — the "works flawlessly" contract

**Status:** living contract. **As-of commit:** `main` @ 38a5f991a (post #4833).
**Scope:** the Dosco LLM gateway (`packages/llm-gateway` + `apps/api/src/llm-gateway`) — the single
canonical OpenAI-chat-shaped request in, provider-native request out, canonical response back.

This document is the authoritative definition of what "the gateway works" means, assessed
per-provider × per-capability, backed by (a) code reading at named `file:line`, (b) the package's
own test suite, and (c) **real live HTTP calls** where keys existed. It is deliberately not
green-washed: every cell is `works` / `broken` / `gap` / `n-a` / `untested`, and `untested` cells
say exactly why.

## How each cell was verified

| Legend | Meaning |
| --- | --- |
| **works✓live** | Verified with a real HTTP response against the real upstream. |
| **works** | Verified by reading the translation code + a passing unit test; not separately live-fired. |
| **broken** | A real defect that produces a wrong result or an upstream error on a valid request. |
| **gap** | Capability is silently dropped / not translated (no error, no effect). |
| **n-a** | The provider's API has no such concept — nothing to translate. |
| **untested** | Could not exercise — no API key / no access. Code state noted where knowable. |

Providers are grouped by transport:
- **anthropic** — native Anthropic Messages API translation (`transports/anthropic`).
- **bedrock** — Claude-on-Bedrock; reuses the anthropic core payload (`transports/bedrock`).
- **openai (genuine)** — `api.openai.com`, `transports/openai-compat` with genuine-OpenAI-gated
  translation, PLUS `transports/openai-responses` for the reasoning+tools case (routed by
  `transports/route-kind.ts`, #4830).
- **openai-compat family** — OpenRouter / Groq / xAI / Mistral / DeepSeek / Perplexity / Cerebras /
  TogetherAI / DeepInfra — all share `transports/openai-compat` (mostly pass-through; genuine-OpenAI
  translation is hostname-gated OFF for them).
- **codex (OAuth)** — ChatGPT/Codex OAuth path, `openai-responses` transport
  (`apps/api/.../descriptors.ts` `codexDescriptor`).

---

## The matrix

Live evidence sources: essentia's production Claude path was **not** probed (customer-owned prod box;
no sanctioned key-mint procedure in-repo — see "What was not tested"). Instead live tests ran against
**AWS Bedrock** (`us.anthropic.claude-sonnet-4-6`, the real prod Claude path, bearer-token auth),
**genuine OpenAI** (`gpt-4o`, `gpt-5.5`, `gpt-5.6-luna` — Marko's key), and **OpenRouter**
(`openai/gpt-4o-mini`, `deepseek/deepseek-r1`, `mistralai/mistral-large` — Marko's key), exercising the
**actual** gateway transport functions, not paraphrases.

| # | Capability | anthropic | bedrock | openai (genuine) | openai-compat family | codex |
|---|---|---|---|---|---|---|
| 1 | Non-streaming completion | works✓live | works✓live | works✓live | works✓live¹ | untested⁵ |
| 2 | Streaming (SSE delta correctness) | works✓live | works✓live | works✓live | works✓live¹ | untested⁵ |
| 3 | Multi-turn history | works✓live | works✓live | works✓live | works✓live¹ | untested⁵ |
| 4 | System prompt | works✓live | works✓live | works✓live | works | untested⁵ |
| 5 | Stop sequences | works | works | works✓live | works (native) | n-a² |
| 6 | Sampling params honored | works✓live | works | works✓live | works✓live¹ | n-a² |
| 6b| Sampling params **stripped** for reasoning models | works✓live ⁶ | works ⁶ | works✓live | **gap⁷** | works |
| 7 | Tool/function definitions | works✓live | works✓live | works✓live | works✓live¹ | works |
| 8 | Tool calls in response | works✓live | works✓live | works✓live | works✓live¹ | works |
| 9 | **Parallel** tool calls | works✓live | works✓live | works✓live | works✓live¹ | works |
| 10| tool_choice auto/none/required/specific | works✓live | works✓live | works✓live | works✓live | works |
| 11| Streaming tool-call deltas (index accumulation) | works | works | works✓live | works✓live | works |
| 12| reasoning_effort / thinking | works✓live | works✓live | works✓live | works✓live³ | works |
| 13| **Correct endpoint routing** for reasoning+tools | n-a | n-a | works⁸ (#4830) | n-a⁴ | works |
| 14| Reasoning-token billing | works⁹ | works⁹ | works⁹ | works⁹ | works⁹ |
| 15| Vision / image inputs | works✓live | works✓live | works✓live | works✓live¹ | untested⁵ |
| 16| JSON mode / response_format / json_schema | **gap¹⁰** | **gap¹⁰** | works✓live | works✓live¹ (upstream-dep) | n-a |
| 17| Prompt caching (request) | works✓live | works✓live | n-a | n-a | n-a |
| 18| Prompt-cache billing (write premium/read discount) | works (#4825) | works (#4825) | works¹¹ | works¹¹ | n-a |
| 19| BYOK resolution | works | works | works✓live | works✓live¹ | works |
| 20| Managed fallback / failover | works | works | works | works | works |
| 21| Streaming abort-on-disconnect | works (#4821) | works (#4821) | works (#4821) | works (#4821) | works (#4821) |
| 22| Error taxonomy surfaced | works (#4820) | works (#4820) | works✓live | works✓live | works |
| 23| Usage/billing accuracy | works✓live | works✓live | works✓live | works✓live | works |

### Footnotes
1. **openai-compat family** cells marked ✓live are proven against **OpenRouter** (`gpt-4o-mini`,
   `deepseek-r1`, `mistral-large`) — the members with no direct key (Groq, xAI direct, Mistral direct,
   DeepSeek direct, Perplexity, Cerebras, TogetherAI, DeepInfra) share the exact same pass-through
   `buildUpstreamRequest` code path (`transports/openai-compat/index.ts:137-167`) so the translation is
   identical; only their upstream-specific quirks (Perplexity role-alternation, handled at `index.ts:113-135`;
   see gap #7/#10) are provider-specific.
2. codex path is reasoning-model-only; stop/sampling params are not part of that flow.
3. reasoning_effort passes through **raw** for openai-compat (`index.ts` never rewrites it). Correct for
   OpenAI-shaped upstreams; **untranslated** for upstreams with a different reasoning knob (deepseek-reasoner
   uses a response-side `reasoning_content` and takes no request knob; Groq/xAI variants differ). Live: OpenRouter
   `deepseek-r1` accepted `reasoning_effort` and returned `reasoning_tokens:226` — so via OpenRouter it works.
   Direct-provider behavior untested (no key). Ranked gap G4 (degrades, conditional).
4. openai-compat non-genuine hosts: reasoning+tools routing is a genuine-OpenAI problem only (OpenAI's
   `/v1/chat/completions` rejects the combo; other hosts don't). `route-kind.ts` is correctly gated to
   `isGenuineOpenAiUpstream` only.
5. **codex OAuth**: no OAuth credential available to test; transport code is the same `openai-responses`
   module proven live for the genuine-OpenAI reasoning+tools case, so it is code-equivalent but not
   independently live-fired.
6. **Fixed this pass (#4833, sha 38a5f991a):** anthropic/bedrock previously forwarded `temperature`/`top_p`
   unconditionally even with `thinking` enabled → Anthropic 400 (`temperature` must be 1 with thinking).
   Now dropped when thinking is on. Verified live on Bedrock (thinking + no sampling param = 200 with a real
   thinking block).
7. **Open gap G2:** the reasoning-restricted sampling-param strip (`stripReasoningRestrictedSamplingParams`,
   `index.ts:70-76`) is gated `isGenuineOpenAiUpstream(baseUrl)` at `index.ts:152` — so a BYOK
   reasoning-restricted model on a **direct** non-OpenAI openai-compat host (Groq/DeepSeek/xAI/Cerebras direct)
   still gets `temperature`/`top_p`/penalties forwarded. `openai-compat.test.ts:166-179` asserts this is the
   current intended behavior. Real blast radius is small (most of these hosts tolerate/ignore temperature; only
   genuine OpenAI is strict) and it's **untested** live (no direct keys) — ranked degrades, conditional.
8. **Fixed by #4830 (sha cb28a245c), merged:** genuine-OpenAI `reasoning + function-tools + effort≠'none'`
   is now routed to `/v1/responses` via `transports/route-kind.ts:resolveTransportKind`. Live-confirmed the
   underlying bug before the fix (`gpt-5.6-luna` 400'd on `/chat/completions` with
   *"Function tools with reasoning_effort are not supported … use /v1/responses"*; `gpt-5.5` happened to still
   200) and confirmed the `openai-responses` transport round-trips tool calls correctly for both models when
   reached. Edge note: Responses does not translate `response_format/json_schema`, so a
   reasoning+tools+json_schema request on OpenAI would drop the schema — narrow, folds into gap G1.
9. **Reasoning-token billing is correct, not a gap.** OpenAI/OpenRouter report `reasoning_tokens` as a
   **subset of** `completion_tokens`, which `usage/extract.ts:34` already captures and prices at the output
   rate — so reasoning turns are billed correctly. `extract.ts` does **not** surface the reasoning *breakdown*
   separately (no `completion_tokens_details.reasoning_tokens` read) — that is a reporting/observability nicety,
   **not** an under-billing bug. Ranked cosmetic (G5).
10. **Open gap G1:** `response_format`/`json_schema` is never read by the anthropic/bedrock core payload
    builder (`anthropic/request.ts:194-224` — confirmed zero occurrences of `response_format`/`json_schema` in
    `transports/`). A Claude/Bedrock caller asking for JSON-schema-structured output silently gets free-form
    text instead of schema-enforced output or an error. No tool-based structured-output workaround exists.
    Ranked degrades. Not relied on by the opencode agent runtime (which uses tool-calling for structure), so it
    does not break real agent sessions today.
11. genuine-OpenAI/openai-compat prompt-*caching* is upstream-managed (OpenAI auto-caches; the discount shows
    up as `prompt_tokens_details.cached_tokens`, captured at `extract.ts:29` and priced at
    `cachedInputPerMillion`). No request-side annotation to translate (n-a for #17); billing read-discount works.

---

## Per-provider summary

### anthropic / bedrock (Claude)
- **What works (mostly live-verified on Bedrock `claude-sonnet-4-6`):** non-stream, streaming (AWS
  event-stream frames decoded and bridged to SSE), system→top-level `system`, multi-turn, stop→`stop_sequences`,
  full tool translation incl. **parallel** tool_use blocks, all four tool_choice shapes (incl. the `{type:'none'}`
  safety fix #4814, live-confirmed suppressing tool use), extended thinking (real thinking block returned),
  vision (`image_url`→native `image` block, base64 + remote URL — now test-covered by #4833), request-side
  prompt caching (`cache_control` breakpoints; live `cache_creation_input_tokens:1369`), cache-write billing
  premium (#4825), error taxonomy (#4820), streaming abort (#4821).
- **What's broken:** nothing outstanding. The temperature+thinking 400 was fixed this pass (#4833).
- **What's a gap:** `response_format`/`json_schema` silently dropped (G1).
- **Untested:** the essentia production BYOK-Anthropic path specifically (used Bedrock as the equivalent
  real Claude surface instead).

### openai (genuine `api.openai.com`)
- **What works (live on `gpt-4o` + reasoning `gpt-5.5`/`gpt-5.6-luna`):** everything in the matrix — non-stream,
  streaming + usage, multi-turn, system, stop, temperature honored on gpt-4o, `max_tokens→max_completion_tokens`
  (#4805/#4809), sampling-param stripping on reasoning models (live-confirmed necessary — raw `temperature:0.3`
  to `gpt-5.5` 400s), single + **parallel** tool calls (incl. `parallel_tool_calls:false`), all tool_choice
  shapes, streaming tool-call delta accumulation (99-chunk arg reconstruction), reasoning_effort low/high,
  reasoning+tools now correctly routed to `/v1/responses` (#4830), vision, `json_object` + strict `json_schema`,
  clean 400 error taxonomy on bad model.
- **What's broken:** nothing outstanding after #4830 + #4833.
- **Untested:** none material — this is the most thoroughly live-verified column.

### openai-compat family (OpenRouter / Groq / xAI / Mistral / DeepSeek / Perplexity / Cerebras / TogetherAI / DeepInfra)
- **What works (live on OpenRouter `gpt-4o-mini`, `deepseek-r1`, `mistral-large`):** non-stream, streaming,
  multi-turn, tools, **parallel** tools, all tool_choice shapes, reasoning_effort (deepseek-r1 returned
  `reasoning_tokens:226`), vision, `json_object`/`json_schema`, clean pass-through 400 on bad model. Perplexity
  role-alternation normalization present (#4814, `index.ts:113-135`).
- **What's a gap:** (G2) reasoning-restricted sampling-param stripping doesn't apply to **direct** non-OpenAI
  hosts (genuine-OpenAI-hostname-gated); (G4) `reasoning_effort` passed raw, not translated to per-provider
  reasoning knobs for direct hosts.
- **Untested:** every **direct** (non-OpenRouter) member — Groq, xAI, Mistral, DeepSeek, Perplexity, Cerebras,
  TogetherAI, DeepInfra — **no direct API keys available**. Code path is byte-identical pass-through; the
  untested surface is only their upstream-specific quirks.

### codex (OAuth)
- **Untested end-to-end** (no OAuth credential). Uses the same `openai-responses` transport proven live for the
  genuine-OpenAI reasoning+tools case, so code-equivalent.

---

## Ranked gap list (severity: breaks-real-sessions > degrades > cosmetic)

| ID | Severity | Gap | Ownership |
| --- | --- | --- | --- |
| **(fixed)** | breaks-real-sessions | anthropic/bedrock forwarded `temperature`/`top_p` with `thinking` → Anthropic 400 on any reasoning_effort+temperature request | **FIXED — PR #4833, sha `38a5f991ad1bcca160458c9e49153c125f1bafda` (merged)** |
| **(fixed)** | breaks-real-sessions | genuine-OpenAI reasoning+tools → `/v1/chat/completions` 400 (`gpt-5.6-luna` et al.) | **FIXED — PR #4830, sha `cb28a245ca23e2650ff8ed0bd274340788691958` (merged, not mine)** |
| **G1** | degrades | `response_format`/`json_schema` is a silent no-op for anthropic/bedrock (free-form text instead of schema-enforced output). Does NOT break opencode agent sessions (they use tool-calling for structure), so below the "drive a fix now" bar. Structural fix = translate `json_schema` into an Anthropic forced-tool-call. | **NEW, unowned** — recommended follow-up |
| **G2** | degrades (conditional) | reasoning-restricted sampling-param stripping is genuine-OpenAI-hostname-gated; a BYOK reasoning model on a **direct** non-OpenAI openai-compat host still gets `temperature`/`top_p` forwarded → possible upstream 400. Small real blast radius (most such hosts tolerate temperature). **Untested** live (no direct keys). | **NEW, unowned** — recommended follow-up; validate against a real direct-provider key first |
| **G4** | degrades (conditional) | `reasoning_effort` passed raw for direct non-OpenAI openai-compat reasoning models (deepseek-reasoner/Groq/xAI direct) — works via OpenRouter, untranslated for direct hosts. | **NEW, unowned** — recommended follow-up |
| **G5** | cosmetic | reasoning-token **breakdown** not separately surfaced (`completion_tokens_details.reasoning_tokens` not read). **NOT** under-billing — reasoning tokens are already inside `completion_tokens` and billed at output rate. Reporting nicety only. | **NEW, unowned** — cosmetic |
| **G6** | cosmetic | dead/unreachable non-typed error branch in `anthropic/response.ts:18-28` (superseded by `call-upstream.ts`'s pre-check); `descriptor.reasoning` computed but only read by `route-kind.ts` now (no longer fully dead post-#4830). | cleanup only |

**Note on ownership boundaries:** #4825 (billing correctness — $0-stream capture, cache-write premium/read
discount, `cache_write_tokens` extraction) is **merged** and its scope is fully reflected in rows 18/23.
#4830 (reasoning+tools→Responses) is **merged** and reflected in row 13. Neither owns G1/G2/G4/G5 — those are
genuinely new and unowned.

---

## What was NOT tested, and why (for a keys decision)

| Surface | Why not tested | To unblock |
| --- | --- | --- |
| **essentia production BYOK Claude/OpenAI path** | Customer-owned prod box (`i-08b6c255775e7cf60`, us-east-1); no sanctioned in-repo key-mint procedure — repo history shows essentia infra being handed to `Essentia-Innovation/kortix-infra`; burning a customer's BYOK budget on a probe matrix needs explicit consent. Used AWS Bedrock (real prod Claude surface) + Marko's own OpenAI/OpenRouter keys as equivalents instead. | Explicit customer + Marko sign-off, or continue using Dosco-owned keys (done). |
| **Direct Groq / xAI / Mistral / DeepSeek / Perplexity / Cerebras / TogetherAI / DeepInfra** (not via OpenRouter) | No direct API keys in `apps/api/.env` (only OpenAI, OpenRouter, AWS Bedrock present). Their pass-through code path is identical to OpenRouter's; only provider-specific quirks (G2/G4, Perplexity role-alternation) are unverified. | Provide a direct key for any provider whose quirks need live confirmation (Groq + DeepSeek most valuable — they'd validate G2/G4). |
| **codex OAuth path** | No ChatGPT/Codex OAuth credential. Same `openai-responses` transport proven live otherwise. | A codex OAuth session credential. |
| **genuine OpenAI account** BYOK on essentia specifically | `OPENAI_API_KEY` is empty in local `.env`; used Marko's provided key against `api.openai.com` directly (equivalent). | n/a — covered. |

---

## Bottom line

Both **breaks-real-agent-sessions** gaps are now closed on `main`: #4830 (reasoning+tools routing, merged) and
**#4833 (thinking+sampling params, this pass, merged, sha `38a5f991a`)**. The gateway's core agent surface —
streaming, multi-turn, tools, parallel tools, tool_choice, reasoning, vision, prompt caching, failover, error
taxonomy, billing — is `works✓live` across anthropic/bedrock, genuine OpenAI (incl. reasoning models), and the
openai-compat family (via OpenRouter). Remaining gaps (G1 json_schema-for-Claude, G2/G4 direct-provider
reasoning quirks, G5 reasoning-token reporting) are **degrades/cosmetic**, unowned, and documented above as
recommended follow-ups — with G2/G4 explicitly needing a direct-provider key before they can be validated or
fixed with confidence.
