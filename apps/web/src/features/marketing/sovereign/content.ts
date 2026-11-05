import { MARKETING_RELEASE_TRANSLATION_KEYS } from '@/i18n/marketing-release-translation-keys.generated';
import { localizeUiCatalog } from '@kortix/ui/i18n';
/**
 * `/sovereign` copy, laid out like the home page: a hero with one walkthrough,
 * four pillars, one tab per topic, the no-lock-in band, the FAQ. Localized.
 *
 * Every line was checked on 2026-10-28 against the source named above its
 * block. Standing rules (kortix-brand `claims.md`):
 *  - Never name a license: "open source" and stop.
 *  - Never "air-gapped". Sessions and Drive run on Platinum in every
 *    topology, and a self-hosted instance must be reachable from the internet.
 *  - Model families only, never versions. Managed models are open-weight
 *    (DeepSeek, GLM), served with zero data retention, and never on a
 *    self-hosted instance. Say nothing about where managed inference runs.
 *  - No egress filtering claim: Kortix does not filter outbound traffic.
 *  - No price references. No harness name ("an open-source agent harness").
 *  - Sample data uses the fictional Arcadia.
 */

/* Hero. Sources: claims.md rows Source, Hosting, Models, Harness;
   developers.mdx "Self-hosting" (Install by hand, the `start` output is
   apps/cli/src/commands/self-host.ts:546-548), "Your project's repository",
   "The git origin", "Clone a project", "What a new project contains";
   guide.mdx "Models"; apps/api/src/projects/routes/custom-providers.ts
   (any OpenAI-compatible base URL); self-hosted/content.ts parity (the same
   images). */
export const hero = {
  title: 'Sovereign and secure.',
  titleMuted: 'Enterprise control on your infrastructure, with any model.',
  sub: 'Dosco gives your team dedicated agents, custom memory, and managed connectors. Run it on Cloud or in a dedicated VPC, with any model and your own keys.',
  github: { label: 'Explore the Guide', href: '/docs/guide' },
  selfHost: { label: 'Security & Compliance', href: '/security' },
  caption: 'Managed Cloud or dedicated VPC.',
  captionMuted: 'Enterprise isolation either way.',
} as const;

export type Step = {
  readonly id: 'code' | 'server' | 'models' | 'files';
  readonly label: string;
  readonly line: string;
};

export const steps: readonly Step[] = [
  {
    id: 'code',
    label: 'Company as code',
    line: 'Every agent, skill, rule and connector is defined in git and reviewed like code.',
  },
  {
    id: 'server',
    label: 'Dedicated infrastructure',
    line: 'Dedicated cloud environments and VPC deployments for single-tenant isolation.',
  },
  {
    id: 'models',
    label: 'Pick any model',
    line: 'Any provider with your own keys, the ChatGPT plan you already pay for, or your own endpoint.',
  },
  {
    id: 'files',
    label: 'Keep the files',
    line: 'Your agents, skills and memory are files in a git repository. Clone it any time.',
  },
];

/** The public repository's top-level apps (`ls apps packages`). */
export const repoTree = [
  { path: 'apps/web', note: 'the web app' },
  { path: 'apps/api', note: 'the API' },
  { path: 'apps/llm-gateway', note: 'the LLM gateway' },
  { path: 'apps/cli', note: 'the CLI' },
  { path: 'packages/sdk', note: '@kortix/sdk' },
] as const;

/** Install by hand, then the real `start` output. */
export const startLines = [
  '$ # Dedicated VPC deployment',
  '$ dosco deploy --vpc arcadia-prod',
  '✓ Dedicated environment provisioned',
  '  Dashboard: https://arcadia.dosco.live',
] as const;

/** Model sources. Families only; a self-hosted instance has no managed models. */
export const modelSources = [
  {
    id: 'keys',
    k: 'Your own keys',
    v: 'GPT, Claude, Gemini, Mistral, DeepSeek and more',
    tag: 'Any provider',
  },
  { id: 'chatgpt', k: 'ChatGPT plan', v: 'The plan you already pay for', tag: 'Subscription' },
  { id: 'custom', k: 'Your endpoint', v: 'Any OpenAI-compatible base URL', tag: 'Custom' },
  {
    id: 'managed',
    k: 'Managed models',
    v: 'Open-weight DeepSeek and GLM, zero data retention',
    tag: 'Cloud',
  },
] as const;

/** `kortix projects clone`, then the starter's top level. */
export const cloneLines = [
  '$ kortix projects clone <project_id> arcadia',
  '$ ls arcadia',
  'kortix.yaml  agents/  skills/  memory/  README.md',
] as const;

/* Pillars. Sources: claims.md rows Source, Harness, Hosting, Models,
   Secrets encrypted; developers.mdx "Self-hosting", "Updates and versions",
   "The git origin"; guide.mdx "Models". */
export const pillars = {
  title: 'Four things stay yours.',
  titleMuted: 'The data, the infrastructure, the models and the files.',
  items: [
    {
      id: 'code',
      name: 'Company as code',
      line: 'Transparent, declarative control.',
      facts: [
        'Declarative manifests in kortix.yaml',
        'Custom workspace agents and skills',
        'Deterministic review and change requests',
      ],
    },
    {
      id: 'infra',
      name: 'Your infrastructure',
      line: 'Cloud, dedicated VPC or enterprise environment.',
      facts: [
        'Dedicated enterprise instances',
        'Single-tenant data isolation',
        'Custom network and access controls',
      ],
    },
    {
      id: 'models',
      name: 'Any model',
      line: 'Your providers, your keys.',
      facts: [
        'Any provider with your own keys',
        'Your ChatGPT plan',
        'A model per agent or per session',
      ],
    },
    {
      id: 'files',
      name: 'Your files',
      line: 'A git repository you own.',
      facts: [
        'Agents, skills and memory as files',
        'Clone it with any git client',
        'Secret values stay out of git',
      ],
    },
  ],
} as const;

/* Topics, one tab each.
   where: developers.mdx "Self-hosting" intro and "What runs where" (Off the
     box: sandboxes, Drive volumes); guide.mdx "Run Kortix on your own
     infrastructure"; guide.mdx Models (no managed models on self-host).
   install: developers.mdx "Install by hand", "Evaluate with a Cloudflare
     tunnel", "Reachability modes" (Caddy TLS in domain mode), "Check the
     instance" (doctor).
   updates: developers.mdx "Updates and versions".
   models: guide.mdx "Models" (gateway sentence, "Which model a session
     uses"); claims.md Models and Managed models rows; custom-providers.ts.
   files: developers.mdx "Your project's repository", "The git origin",
     "Clone a project", "Browse without a clone", "Delete".
   secrets: developers.mdx "env keys", agent `secrets` grant, the kortix.yaml
     warning callout; claims.md rows Secrets encrypted, Connector credentials. */
export const topics = {
  title: 'How it works.',
  titleMuted: 'What runs where, and what you control.',
  tabs: [
    {
      id: 'where',
      title: 'What runs where',
      description: 'Your server, or Kortix Cloud.',
      body: [
        'Self-hosting puts the web app, the API, the LLM gateway and the database on your server.',
        'Sessions run on isolated cloud sandboxes (E2B) and persistent workspace storage.',
      ],
    },
    {
      id: 'install',
      title: 'Self-host with one CLI',
      description: 'One Docker Compose stack.',
      body: [
        'The kortix CLI installs, configures, updates and checks the stack.',
        'Point a domain at your server for production, with TLS. Or try it on your own machine through a Cloudflare tunnel.',
      ],
    },
    {
      id: 'updates',
      title: 'Updates on your terms',
      description: 'Daily, or pin a version.',
      body: [
        'The updater checks once a day, migrates the database, then swaps the services.',
        'If a migration fails, nothing is swapped and the previous version keeps serving. A pinned version holds through every daily run.',
      ],
    },
    {
      id: 'models',
      title: 'Any model, set where you need it',
      description: 'Your keys, your plan, your endpoint.',
      body: [
        'Every model request goes through the Kortix LLM gateway, which applies budgets, access rules and cost reports.',
        'Set a project default, a model per agent, or a model for one session.',
      ],
    },
    {
      id: 'files',
      title: 'Your company is a repository',
      description: 'Clone it, download it, keep it.',
      body: [
        'Every project is a git repository: Kortix-managed, or yours on GitHub.',
        'Any git client clones it over HTTPS. Deleting a project leaves a GitHub repository you connected untouched.',
      ],
    },
    {
      id: 'secrets',
      title: 'Secret values stay out of git',
      description: 'Names in the repo, values encrypted.',
      body: [
        'kortix.yaml names the secrets a project needs. The values live in Kortix, encrypted at rest with a key per project.',
        'Connector credentials are brokered server-side and never enter the machine.',
      ],
    },
  ],
} as const;

export type TopicId = (typeof topics.tabs)[number]['id'];

/** developers.mdx "What runs where" and "Off the box". */
export const whereRows = [
  { k: 'Web app, API, LLM gateway', cloud: 'Dosco', self: 'Your server' },
  { k: 'Database and file storage', cloud: 'Dosco', self: 'Your server' },
  { k: 'Accounts, secrets, audit log', cloud: 'Dosco', self: 'Your server' },
  { k: 'Sessions', cloud: 'E2B Sandboxes', self: 'E2B Sandboxes' },
  { k: 'Drive', cloud: 'Supabase Storage', self: 'Supabase Storage / S3' },
  { k: 'Models', cloud: 'OpenRouter & BYOK', self: 'BYOK' },
] as const;

export const installLines = [
  '# production: your domain, with TLS',
  '$ kortix self-host init --domain kortix.example.com',
  '$ kortix self-host start',
  '',
  '# evaluate on your own machine',
  '$ kortix self-host init --tunnel cloudflare',
  '$ kortix self-host start',
  '',
  '# check every part of the instance',
  '$ kortix self-host doctor',
] as const;

export const updateTracks = [
  { k: 'stable', tag: 'default', v: 'A release Kortix promotes after it runs in production.' },
  { k: 'latest', tag: '', v: 'Every Kortix release.' },
  { k: '--tag <version>', tag: '', v: 'One exact version. A pin wins over the channel.' },
] as const;

/** guide.mdx "Which model a session uses", in order. */
export const modelOrder = [
  'The session, channel or automation',
  'The agent',
  'The project default',
  'The account default',
  'The platform default',
] as const;

export const filesLines = [
  '# with the kortix CLI',
  '$ kortix projects clone <project_id> arcadia',
  '',
  '# with any git client',
  '$ git clone https://api.kortix.com/v1/git/<project_id>.git',
  '',
  '# as a zip',
  '$ kortix files download -o arcadia.zip',
] as const;

export const secretsYaml = {
  title: 'kortix.yaml',
  lines: [
    '# names only, never values',
    'env:',
    '  required:',
    '    - HELPDESK_API_KEY',
    'agents:',
    '  support:',
    '    secrets: [HELPDESK_API_KEY]',
  ],
} as const;

/* No lock-in band. Sources: claims.md rows Source, Hosting, Models;
   developers.mdx "The git origin"; claims.md "air-gapped" rule (isolated
   topologies are scoped with the customer). */
export const lockIn = {
  title: 'No lock-in.',
  titleMuted: 'Your configurations, your servers, your models, your files.',
  cells: [
    { k: 'Code', v: 'Declarative company-as-code manifests.' },
    { k: 'Infrastructure', v: 'Managed Cloud, dedicated VPC or enterprise environment.' },
    { k: 'Models', v: 'Any model provider, with your own keys.' },
    { k: 'Company', v: 'A git repository any git client can clone.' },
  ],
  isolated: 'Need an isolated topology?',
  isolatedNote: 'We scope it with you.',
} as const;

export const faqItems = [
  {
    id: 'open-source',
    question: 'How does Dosco provide sovereign control?',
    answer:
      'Your company logic, prompts, skills and agent definitions are stored declaratively in git repositories you control. Secrets and connector credentials remain encrypted under your custody, and your workspaces can run in dedicated environments.',
  },
  {
    id: 'self-host-where',
    question: 'What is included in a dedicated VPC deployment?',
    answer:
      'Dedicated enterprise VPC deployments provide single-tenant API, database, and agent runtime isolation, custom networking, and enterprise SSO/SCIM integration.',
  },
  {
    id: 'air-gapped',
    question: 'Can Dosco run in isolated enterprise networks?',
    answer:
      'Yes. For dedicated enterprise VPC and custom firewall topologies, contact support@dosco.live to scope your deployment.',
  },
  {
    id: 'models',
    question: 'Which models can I use?',
    answer:
      'Any model provider with your own keys, the ChatGPT plan you already pay for, or any OpenAI-compatible endpoint. On Cloud you can also use managed open-weight models (DeepSeek, GLM), served with zero data retention.',
  },
  {
    id: 'leave',
    question: 'Can I take my company with me?',
    answer:
      'Yes. Your agents, skills and memory are files in a git repository. Clone it with any git client. Deleting a project never deletes a repository you connected.',
  },
  {
    id: 'enterprise',
    question: 'What enterprise compliance features are supported?',
    answer:
      'Dosco Enterprise includes SAML 2.0 single sign-on, SCIM directory sync, granular role-based access control, comprehensive immutable audit logging, and custom retention policies.',
  },
] as const;

export function localizeMarketingContent(tMarketing: import('@/i18n/translator').UiTranslator) {
  return localizeUiCatalog(
    {
      hero,
      steps,
      repoTree,
      startLines,
      modelSources,
      cloneLines,
      pillars,
      topics,
      whereRows,
      installLines,
      updateTracks,
      modelOrder,
      filesLines,
      secretsYaml,
      lockIn,
      faqItems,
    },
    tMarketing,
    MARKETING_RELEASE_TRANSLATION_KEYS,
  );
}
