/**
 * `/about` copy — the founder's thesis, in his framing, cut to the bone.
 *
 * Plain English lives here, not in `apps/web/translations/*.json`, so the copy
 * can iterate before paying the 8-locale parity gate (`pnpm i18n:translations`).
 *
 * Voice rules: the `comms` skill. Long form: `MANIFESTO.md`.
 *
 * ACCURACY GATE for this page specifically:
 *  - This is a vision page, so forward-looking language is wanted. It must
 *    never read as shipped capability. TRAINING, RL and EVALS ARE NOT SHIPPED —
 *    every mention is written as direction, never as something a reader can do
 *    today. Anything in the present tense is true today.
 *  - `platform.items` carries NO status field and the page renders no status
 *    chip: the tense does the work. A row whose capability does not ship is
 *    written in the future ("the layer we are building next", "then …"), never
 *    in the present. Adding a row for something unshipped means writing it that
 *    way — do not reintroduce a status marker, and do not let a present-tense
 *    sentence describe a capability that does not exist.
 *  - Competitor names, exactly: **Claude Cowork** (one word, lowercase `w`) and
 *    **ChatGPT Work** (two words). There is no "Claude Work" and no
 *    "ChatGPT Cowork". Claim nothing about their limits or concurrency.
 *  - Never name a licence — "open source" and stop. Never claim a certification.
 *  - NEVER claim blanket "microVM isolation": true for Platinum, not for
 *    Daytona, which is the default. Write "its own isolated machine".
 *  - NEVER write that a secret is "never visible to the model". A granted
 *    runtime secret is a real env value in the session. CONNECTOR credentials
 *    are the ones brokered server-side that never enter the machine.
 *  - Never claim egress is controlled at the network. Nothing implements it.
 *  - OpenCode is the agent harness. Name no other.
 *  - The GitHub star count is the only sanctioned number, read live from
 *    `/api/github-stars`. No funding, headcount, customers or other metrics.
 *  - Keep it short. Every sentence that restates the one above it comes out.
 */

export const hero = {
  eyebrow: 'About 火 Dosco Network',
  title: 'Dosco delivers deliverables — not just chat.',
  lead: 'Dosco is a flexible AI agent that becomes any role — UI engineer, logo designer, accountant, PR — at 100% capacity. Hand it a sprint and it drops in and executes. The perfect coworker.',
  ctaPrimary: 'Talk to us',
  ctaPrimaryHref: '/contact',
  ctaSecondary: 'Request a demo',
  ctaSecondaryHref: '/contact',
  imageAlt: '火 Dosco Network team (illustration)',
  starsCaption: 'the 火 Dosco Network',
} as const;

/** The three claims the page rests on. One headline, one paragraph, no more. */
export const statements = [
  {
    id: 'own',
    n: '01',
    title: 'Dosco delivers deliverables, not chat.',
    body: 'Dosco is not a chatbot that returns text. It ships actual work that counts — finished designs, code, reports, filings. The output is the deliverable.',
  },
  {
    id: 'closed',
    n: '02',
    title: 'One agent, every role at 100% capacity.',
    body: '火 Dosco Network becomes whatever you need — UI engineer, logo designer, accountant, PR. Each role runs at full capacity, the moment you need it.',
  },
  {
    id: 'shift',
    n: '03',
    title: 'The perfect coworker drops into your sprint.',
    body: 'Hand Dosco a sprint and it executes — planning, building, and landing the work end to end. Autonomy shifts from humans to agents, and 火 Dosco Network is the teammate that does it.',
  },
] as const;

/**
 * The six-verb spine — the shape of the platform, not a feature checklist.
 * There is no status column: the first four rows are present tense because they
 * are true today, and the last two are future tense because they are not.
 */
export const platform = {
  eyebrow: 'The platform',
  title: 'Build, host, manage, monitor. Then train and eval.',
  sub: 'One place your agents run and all of your context connects. Six verbs, one system.',
  items: [
    {
      id: 'build',
      verb: 'Build',
      body: 'Agents, skills, connectors, triggers and memory are files in one git repo that is the company.',
    },
    {
      id: 'host',
      verb: 'Host',
      body: 'Every session runs on its own isolated machine. Thousands run in parallel on one config.',
    },
    {
      id: 'manage',
      verb: 'Manage',
      body: 'Per-resource permissions for people and agents. Secrets encrypted at rest; connector credentials brokered server-side, never entering the machine.',
    },
    {
      id: 'monitor',
      verb: 'Monitor',
      body: 'Watch a session live, diff every change to an agent or a skill, and land work through a change request.',
    },
    {
      id: 'train',
      verb: 'Train',
      body: 'The layer we are building next: your own models, trained on the work your agents already did, inside the same platform.',
    },
    {
      id: 'eval',
      verb: 'Eval',
      body: 'Then evals and reinforcement learning, scored on your own sessions rather than a public benchmark.',
    },
  ],
} as const;

export const closing = {
  title: 'Every team will run on agents. 火 Dosco Network is the one you own.',
  ctaPrimary: 'Talk to us',
  ctaPrimaryHref: '/contact',
  ctaSecondary: 'Read the code',
  ctaSecondaryHref: '#',
} as const;
