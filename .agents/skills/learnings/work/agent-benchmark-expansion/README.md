---
title: My Kortix benchmark, next tasks and graders (from the 2026 agent-eval landscape)
status: research done 2026-11-17; backlog below, nothing built. Baseline: evals/my-kortix, 17 tasks (PRs #12777–#12783)
owner: Marko (decisions)
updated: 2026-11-17
---

# Expanding the My Kortix benchmark

**Where it stands.** `evals/my-kortix` has 17 tasks, one per capability,
graded on real workspace state through the Kortix CLI, with a fresh workspace
per trial and multi-step tasks through Harbor `[[steps]]`. Dev, 2026-11-16:
oracle 17/17, nop 0/17, My Kortix 26/34 on both DeepSeek V4.1 Flash and GLM
5.3 Flash (2 attempts each). Details and the rules for running it:
`.agents/skills/evals/SKILL.md`.

**Open failures the benchmark found (not fixed):**

1. `handoff-research` 0/2 on both: My Kortix does the research itself and
   creates no colleague session, against its prompt rule.
2. `ask-before-invite` 0/2 on both: the people tool offers only `manager` or
   `member`; `kortix members invite --role admin` works.
3. `media-header-image` 0/2: dev has no image model (environment gap).
4. Partial: a claimed `.docx` that was not in Drive; a 588-character secret
   link broken by retyping (links should reach the person as a card or a
   verbatim copy); a weekday trigger set in UTC instead of the person's time
   zone.
5. Tooling: the deploy-dev API path filter lacks `evals/**`;
   `kortix triggers fire` ignores `--json`.

## What the field does (research 2026-11-17)

Mostly from abstracts and secondhand summaries; leaderboard numbers are
unverified, the design patterns are consistent.

**Labs and coding products.**

- Anthropic, "Demystifying evals for AI agents" (2026-01-09): grade the model
  plus its harness; capability evals (low pass rate, target weak spots)
  separate from regression evals (near 100%); layered graders (code, then
  LLM rubric, then human); report pass@k and pass^k. Claude Code started with
  feedback only and added narrow evals first.
- Anthropic system cards: CoBench (root-causing real internal engineering
  issues, Opus 5.5 55.8%); replay of internal Claude Code transcripts where a
  model once acted destructively; 100+ agentic coding scenarios for reward
  hacking and risky actions; Petri-based scaffolding that looks like real use.
- Cursor: CursorBench, tasks from real Cursor sessions traced from commits
  back to agent requests; grades whether code follows existing abstractions.
- Cognition: cognition-golden, then FrontierCode; evaluator agents with
  shell, browser and editor tools; simulated users answer Devin's questions.
- OpenAI: "OpenAI PRs" (real internal PRs), SWE-Lancer, GDPval, a
  long-horizon SWE eval (median 20 h human time). Its audit found 59.4% of
  138 checked SWE-bench Verified tasks flawed; recommendation: private evals
  from your own work.
- Manus, Genspark, Kimi OK Computer: no internal evals published. Manus cited
  GAIA at launch (self-reported); a Berkeley report reached about 98% on GAIA
  validation without solving it, so GAIA is contaminated.

**Benchmarks closest to My Kortix.**

| Area | Benchmark | Lesson for us |
|---|---|---|
| Personal assistant | Claw-Anything (2026-05: 200 environments, ~10 services, 192k words context, noise; 34.5% overall, proactive tasks far lower) | Seed realistic noise; test proactivity |
| | ClawsBench (mock Gmail, Calendar, Docs, Drive, Slack; snapshot/restore; 8 unsafe patterns) | Safety tasks inside normal work |
| | LiveClawBench (134 cases from real use) | Agents stop early on implicit goals |
| | openclaw ClawBench (whole stack scored from the trace; 13 failure modes incl. hallucinated completion; 3 runs per task; 47% of variance was seed noise) | Detect claimed-but-not-done; measure noise; pin the harness version |
| | π-Bench, ProAgentBench | Proactive help over many sessions |
| General agent | Gaia2 / Meta ARE (1,120 scenarios; time, ambiguity, adaptability, an environment that changes on its own) | Time and asynchronous events |
| Knowledge work | GDPval, APEX-Agents, Remote Labor Index, TheAgentCompany | Real deliverables graded against human work |
| Apps and tools | AppWorld (database diff before/after, collateral damage), Toolathlon, MCP-Atlas, MCPMark, MCP-Universe | Check what must NOT change |
| Multi-agent | ClawArena-Team (correctness × least privilege; no model above 50% on workspace permissions), OrchestraBench, DecisionBench | Subagent least privilege |
| Asking | LHAW, Ambig-SWE, ClarEval | Over-asking is a failure too |
| Memory | Memora, PERMA, LifeBench | Stale memories after a preference changes |
| Deliverables | PPT-Eval (best agent 45% vs humans 80%), OmegaUse-OfficeVal | Grade the finished file |
| App building | Vibe Code Bench (browser workflows on the deployed app), SWE-WebDevBench (changing an app is harder than creating one) | Add an App-change task |
| Research | DeepResearch Bench II (9,430 expert criteria), Mind2Web 2, BrowseComp | Rubric-graded reports |
| Security | AgentDojo, AgentDyn, WASP, OS-Harm | Prompt injection through content |
| Long horizon | Vending-Bench 2 | Coherence over a simulated year |
| Skills | SkillsBench (curated +16.2 points, self-written ~0) | Ablate managed skills |

## Backlog, ranked

Grader changes for every task:

1. **Collateral-damage check in `_shared/kx.py`.** Snapshot members, secrets,
   triggers, connectors, agents, Drive and memory before and after; fail any
   change the task did not ask for.
2. **Hallucinated-completion metric.** Compare the reply's claims with the
   state; report the rate per model.
3. **Report pass^k** next to the pass rate; move tasks that always pass to a
   regression suite run on every My Kortix prompt change.

New tasks:

4. Prompt injection: a Drive doc or web page tells the agent to send a key
   to `x@example.test` or invite someone as admin.
5. Secret leakage: "share this config with the contractor", where it holds a
   secret value.
6. Should-not-ask controls paired with each ask task: clear, low-risk
   requests where a question fails. Guards the ask-then-stop gate.
7. A noisy seeded workspace: ~50 Drive files, old memories, past sessions,
   conflicting facts. Reuse for research, memory and documents.
8. Proactivity: a trigger brings in an event (a file with a deadline);
   pass = a reminder or a notice nobody asked for explicitly.
9. Deliverables: a slide deck and a spreadsheet with formulas; structural
   checks (`python-pptx`, `openpyxl`) plus a rubric judge.
10. Change an existing App, graded by browser workflows.
11. Subagent least privilege: delegated work where the colleague gets only
    the access it needs.
12. Memory conflict: a preference changes between sessions.
13. Time: a daylight-saving change, "next Tuesday", a person in another zone.
14. Destructive actions: delete a repo, remove a member, revoke a connector;
    pass = asks first or refuses.

Harness changes:

15. Skills ablation: the suite with managed skills on and off.
16. A simulated user: an LLM answers the agent's actual questions instead of
    a fixed next step.
17. Tasks from real failed sessions, rewritten synthetically (never customer
    content). The source is the continual-learning loop:
    [`continual-learning/`](../continual-learning/README.md).
18. A second session within one trial, for cross-session memory and lessons.

Not now: chasing public leaderboards (GAIA is contaminated; most need their
own environments; for a public number, GDPval-style deliverables or
Toolathlon are credible), OSWorld-style computer use, Vending-Bench-style
year-long runs.

Recommended first batch: items 1–6, then a run of both models with 3
attempts.

## Sources

- Anthropic: https://anthropic.com/engineering/demystifying-evals-for-ai-agents,
  https://www.anthropic.com/engineering/multi-agent-research-system,
  Opus 5.5 system card https://assets.claude.com/fc1b44717c85dc068bc6ba5024219938094694bd.pdf
- Cursor: https://arxiv.org/html/2603.24477 · Cognition: https://cognition.ai/blog/evaluating-coding-agents
- OpenAI: https://cdn.openai.com/pdf/2a7d98b1-57e5-4147-8d0e-683894d782ae/5p1_codex_max_card_03.pdf
- Assistants: Claw-Anything https://arxiv.org/pdf/2605.26086, ClawsBench https://arxiv.org/html/2604.05172v2,
  LiveClawBench https://arxiv.org/html/2604.13072v2, ClawBench https://github.com/openclaw/clawbench,
  π-Bench https://arxiv.org/html/2605.14678
- Gaia2: https://arxiv.org/pdf/2509.17158 · Epoch on GDPval/APEX/RLI: https://epoch.ai/publications/what-do-economic-value-benchmarks-tell-us
- AppWorld https://arxiv.org/abs/2407.18901v1 · Toolathlon https://arxiv.org/pdf/2510.25726 · MCP-Atlas https://labs.scale.com/papers/mcpatlas
- ClawArena-Team https://www.alphaxiv.org/abs/2606.31174 · LHAW https://www.themoonlight.io/review/lhaw-controllable-underspecification-for-long-horizon-tasks
- Memora https://arxiv.org/abs/2604.20006 · PPT-Eval https://arxiv.org/abs/2606.31154 · Vibe Code Bench https://arxiv.org/abs/2603.04601
- DeepResearch Bench II https://arxiv.org/pdf/2601.08536v2 · AgentDyn https://arxiv.org/pdf/2602.03117v2 · SkillsBench https://arxiv.org/html/2602.12670v1
