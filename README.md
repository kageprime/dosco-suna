<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="apps/web/public/brandkit/Logo/Logomark/SVG/Logomark%20White.svg">
  <img src="apps/web/public/brandkit/Logo/Logomark/SVG/Logomark%20Black.svg" alt="火 Dosco" width="200" />
</picture>

# 火 Dosco — the Dosco Agent Network

**The AI agent network that delivers real work, not just chat.**

**The flexible agent that becomes any role at 100% capacity — the perfect coworker for your team.**

[![GitHub stars](https://img.shields.io/github/stars/kortix-ai/CompanyOS?style=flat&color=111111&label=Stars)](https://github.com/kortix-ai/CompanyOS/stargazers)
[![Release](https://img.shields.io/github/v/release/kortix-ai/CompanyOS?style=flat&color=111111&label=Release)](https://github.com/kortix-ai/CompanyOS/releases/latest)
[![Docs](https://img.shields.io/badge/Docs-dosco.live%2Fdocs-111111.svg)](https://dosco.live/docs)
[![Dosco Network](https://img.shields.io/badge/Dosco-Network-111111.svg)](#contributing)

[Website](https://dosco.live) · [Documentation](https://dosco.live/docs) · [Cloud](https://dosco.live) · [Manifesto](MANIFESTO.md)

<br />

<img src="apps/web/public/media/landing/hero-ui.png" alt="Dosco UI" width="960" />

</div>

---

Dosco is the **Dosco Agent Network** — a flexible AI agent that becomes whatever role your team
needs: a UI engineer, a logo designer, an accountant, a PR lead. Each one runs at 100% capacity,
with the judgment to take a sprint, drop in, and execute it end to end.

**Dosco delivers deliverables — actual work that counts**, not just chat responses like a normal
chatbot. Hand it a brief and it comes back with the finished report, deck, code, or shipped change.
Your agents, the skills they share, your company memory, and every connector live in one git repo —
versioned, diffable, and shared by the whole company. The agents work on real **cloud computers** —
an isolated sandbox per session, on its own branch — and land what they produce through a **change
request** a human approves.

Any model, your own API keys, your own infrastructure or our managed cloud.

---

## Quickstart

Run Dosco in five seconds:

```bash
# 1. Install the CLI
curl -fsSL https://dosco.live/install | bash

# 2. Start your first session
kortix
```

The CLI launches the interactive terminal agent (`pi`), signs in with your browser, and opens your
first session — nothing to install. Full command surface: **[CLI reference](https://dosco.live/docs/cli)**.

---

## A company is going to be a git repository

Not as a metaphor — literally something you can clone. Inside it: your agents, the skills they've
built up, the way the work actually gets done, every fact the company has learned, and the
definition of the machines it all runs on. **Versioned. Diffable. Owned outright.**

```
project  (git repo + kortix.yaml)
   └─ session ──> cloud computer: an isolated sandbox on a branch named after the session
                     └─ the agent works
                           └─ change request ──> you review & merge ──> main
```

- Every **session** gets its own **cloud computer** — a disposable, isolated Linux sandbox on its
  own branch. The agent can install, run and break anything; only what it commits survives.
- Work reaches `main` only through a **change request** you approve, so the company self-improves
  one reviewed change at a time.
- Run **thousands of sandboxes in parallel** on the same config, each fully isolated, each feeding
  work back through change requests.

You can `grep` your entire company.

---

## What you manage

| | |
| --- | --- |
| **Agents** | Agents with a scoped reach into tools — markdown at the baseline, with the whole lifecycle open to you. One per role or task, installable in a click, able to rewrite themselves. |
| **Skills** | Reusable know-how that encodes how your company does a job. Written once, shared into every session. |
| **Memory** | A living company brain — plain files today, a system that compounds what it learns over time. |
| **Connectors** | 3,000+ apps in a click — plus MCP, OpenAPI, GraphQL and raw HTTP. Credentials are brokered server-side through one scoped token and never enter the machine. |
| **Secrets** | Encrypted at rest, granted per agent, and injected into the sandbox at runtime. A granted secret is a real environment value inside that session. |
| **Channels** | Slack today, Microsoft Teams behind an operator switch, email and voice experimental. Install the Slack app, invite the bot to a channel, and @-mention it to start a session where your team already works. |
| **Triggers** | Cron and signed webhooks that spawn sessions automatically — every morning, or the instant something happens. |

Work runs three ways: **on-demand** (ask in chat, get it now), **human-assisted** (the agent works
and checks in for the calls that matter), and **automated** (runs on a schedule or trigger, end to
end).

---

## Why Dosco

- **A coworker, not a chatbot.** Dosco delivers finished deliverables — reports, decks, code, shipped changes — not just chat responses.
- **Any role, at 100% capacity.** A flexible agent that becomes a UI engineer, logo designer, accountant, or PR lead the moment you need it.
- **Drops into your sprint.** Give it a sprint, and it executes end to end — the perfect coworker for the work that counts.
- **A workforce, not one assistant.** Org-scale specialist agents that run in parallel and compound a shared memory.
- **Everything is code.** Versioned, reviewable, portable, governable — never a black box. Bring your own models, your own keys, your own infrastructure.

---

## Self-host

Dosco runs on your own infrastructure — a laptop, a VPS, your own VPC, or your own on-prem
network. Start a production-style local instance from Docker images, then switch the CLI between
Cloud and your own hosts:

```bash
curl -fsSL https://dosco.live/install | bash
kortix self-host start
kortix hosts use selfhost  # ↔  kortix hosts use cloud
```

---

## License

Dosco is proprietary software developed by Dosco Tek. See [WHITE-LABEL-LICENSE.md](WHITE-LABEL-LICENSE.md).
