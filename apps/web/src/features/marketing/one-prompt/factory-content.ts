import {
  CREDITS_PER_USD,
  DEFAULT_COMPUTE_HOURLY_PRICE_USD,
  FREE_MONTHLY_CREDITS,
} from '@kortix/ui/internal/billing/compute-pricing';

/**
 * The data on the Software Factory home. Every ticket, command and result is
 * from one real run on a private demo repository (2026-11-10): the nightly tester filed issues #1Ã¢â‚¬â€œ#3, the builder opened pull
 * requests #4Ã¢â‚¬â€œ#6, a reviewer agent ran each one. Nothing here is invented.
 */
export const DEMO = {
  repo: 'Dosco-factory-demo',
  tickets: [
    { number: 1, title: 'POST /todos with malformed JSON crashes the whole server', state: 'in review' },
    { number: 2, title: 'POST /todos/:id/done returns 200 for a nonexistent todo', state: 'in review' },
    { number: 3, title: 'POST /todos accepts a missing, empty or non-string title', state: 'in review' },
  ],
  /** The reviewer's checks on pull request #6, as it reported them. */
  worker: [
    { kind: 'cmd', text: "curl -X POST /todos -d '{bad'   # on main" },
    { kind: 'out', text: '000 Ã‚Â· process exited: SyntaxError at src/server.js:16' },
    { kind: 'cmd', text: "curl -X POST /todos -d '{bad'   # on the fix" },
    { kind: 'ok', text: '400 {"error":"invalid json"} Ã‚Â· GET /todos Ã¢â€ â€™ 200' },
    { kind: 'cmd', text: 'npm test   # 3 consecutive runs' },
    { kind: 'ok', text: '4 pass, 0 fail, each run' },
  ] as Array<{ kind: 'cmd' | 'out' | 'ok'; text: string }>,
  pr: {
    number: 6,
    title: 'fix: return 400 on malformed JSON instead of crashing the server',
    branch: 'Dosco/fix-malformed-json-crash',
    additions: 83,
    deletions: 3,
    checks: ['npm run lint Ã‚Â· exit 0', 'npm test Ã‚Â· 4 pass, 0 fail, 3 runs', 'on main Ã‚Â· crash reproduced', 'on the branch Ã‚Â· 400, server up'],
  },
};

/** A small, valid Dosco.yaml: one agent, what starts it, and the registries it draws on. */
export const MANIFEST = [
  'agents:',
  '  engineer:',
  '    prompt_file: agents/engineer.md',
  '    skills: [software-factory]',
  '    tools: [lookup_order]',
  '    extensions: [review-gate]',
  '    connectors: [helpdesk]',
  '    secrets: [SENTRY_DSN]',
  '',
  'triggers:',
  '  - slug: nightly-tests',
  '    on: { cron: "0 0 2 * * *" }',
  '    run:',
  '      agent: engineer',
  '      prompt: Run the tests. File what fails.',
  '',
  'skills:',
  '  software-factory: skills/software-factory',
  'tools:',
  '  lookup_order: tools/lookup_order.ts',
  'extensions:',
  '  review-gate: { pi: extensions/review-gate.ts }',
  '',
  'connectors:',
  '  - slug: helpdesk',
  '    provider: http',
  '    base_url: https://helpdesk.example.com/api',
  '',
  'sandbox:',
  '  templates:',
  '    - { slug: dev, dockerfile: Dockerfile }',
];

/** What Dosco.yaml defines, one line each. `key` is the YAML key whose lines light up when the part is hovered. */
export const ENGINE = [
  { term: 'Agents', key: 'agents', body: 'Every agent is a pi coding agent you define: its prompt, model, skills and what it may use. Nothing is granted by default.' },
  { term: 'Triggers', key: 'triggers', body: 'What starts an agent: a schedule, a webhook, a Slack message, an app event.' },
  { term: 'Skills', key: 'skills', body: 'Folders of instructions in your repo. An agent loads one when the work calls for it.' },
  { term: 'Tools', key: 'tools', body: 'Your own tools: a TypeScript file in your repo, registered by name, enabled per agent.' },
  { term: 'Extensions', key: 'extensions', body: 'pi extensions change the agent itself: hooks on its lifecycle, new commands, new behavior. A file in your repo or a pinned npm package.' },
  { term: 'Connectors', key: 'connectors', body: '3,000+ apps in a click, plus MCP, OpenAPI and raw HTTP. Rules decide which calls run and which wait for you.' },
  { term: 'Environment', key: 'sandbox', body: 'A Dockerfile for the sandbox each session runs in: your toolchain, your services, your tests.' },
  { term: 'Secrets', key: 'secrets', body: 'The file names them. The values stay encrypted in your workspace and reach only the agents you grant.' },
];

/** A running hour of the default agent computer, from the billing rate card: "$0.11". */
export const COMPUTE_HOURLY = `$${DEFAULT_COMPUTE_HOURLY_PRICE_USD.toFixed(2)}`;
/** The Free plan's monthly credits in dollars: "$5". */
export const FREE_COMPUTE_USD = `$${FREE_MONTHLY_CREDITS / CREDITS_PER_USD}`;

export const FAQ = [
  {
    q: 'How is this different from Claude Code or Codex?',
    // Claude: each step is the unmodified `claude` program in the sandbox (harness/README.md). ChatGPT: pi on the Codex plan's models, not the Codex program.
    a: 'It runs on them. With a Claude subscription, every step runs in Claude Code itself; with ChatGPT, on your Codex plan\'s models. Dosco adds what they need to run 24/7 without you: a cloud computer for each agent, triggers like a failing test, a Sentry error or a merged pull request, your connected tools and encrypted secrets.',
  },
  {
    q: 'What happens when I paste the prompt?',
    a: 'Your coding agent installs the Dosco CLI, signs you in and reads your repository. It finds your tools, connects them and writes Dosco.yaml. Then it runs the factory once, so you see a real result before it starts working on its own.',
  },
  {
    q: 'What is a factory?',
    a: 'An agent with the triggers and skills for one kind of work. The Software Factory turns issues, failing tests and errors into verified pull requests. Each factory starts from a public template that your coding agent adapts to your repository.',
  },
  {
    q: 'Does it work with my existing repository?',
    a: 'Yes. It reads how your repository builds and tests and writes an environment the agents use. Everything it adds is files in your repository, Dosco.yaml first, so you review it like any other change.',
  },
  {
    q: 'Which coding agents and models does it work with?',
    a: 'The prompt runs in Claude Code, Codex, Cursor, OpenCode, pi or any agent with a shell. The cloud agents use your Claude or ChatGPT subscription, or any API key you add.',
  },
  {
    q: 'What can the agents do on their own?',
    a: 'Only what Dosco.yaml allows. Pull requests, posts and outbound messages wait for a person until you allow more. Security fixes always wait.',
  },
  {
    q: 'Is my code safe?',
    a: 'Agents run in isolated cloud sandboxes and never verify against production. Secrets stay encrypted in your workspace and reach only the agents you grant. Dosco is SOC 2 Type I verified.',
  },
  {
    q: 'What does it cost?',
    a: `Adding it is free, and Free includes ${FREE_COMPUTE_USD} of compute every month. Past that you pay only for the cloud computer your agents run on: about ${COMPUTE_HOURLY} an hour, billed per second while it runs. Models run on your own subscription or API key.`,
  },
  {
    q: 'Can I self-host it?',
    a: 'Yes. The code is on GitHub at Dosco-ai/CompanyOS, and the command Dosco self-host start runs it on your own machine or cloud.',
  },
  {
    q: 'How do I turn it off?',
    a: 'Dosco triggers pause <slug> stops one loop, and Dosco triggers pause stops them all. resume starts them again. To remove a factory, delete its files and its line under imports: in Dosco.yaml.',
  },
];

/** The teams the same prompt builds a loop for, from a description. `slug` picks the agent mark. */
export const TEAMS = [
  { slug: 'marketing', name: 'Marketing', line: 'Every merge becomes a changelog, a post and a video.' },
  { slug: 'sales', name: 'Sales', line: 'Every signup researched, scored and drafted before you wake up.' },
  { slug: 'support', name: 'Support', line: 'Every ticket answered in draft or routed to engineering.' },
  { slug: 'recruiting', name: 'Recruiting', line: 'Every applicant scored against the role, with an interview kit.' },
  { slug: 'research', name: 'Research', line: 'Say what to watch. It writes the brief on your schedule.' },
  { slug: 'operations', name: 'Operations', line: 'Say what the back office repeats. It runs it and asks first.' },
];
