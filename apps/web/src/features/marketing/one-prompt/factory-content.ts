/**
 * The data on the Software Factory home. Every ticket, command and result is
 * from one real run on a private demo repository (2026-11-10): the nightly tester filed issues #1–#3, the builder opened pull
 * requests #4–#6, a reviewer agent ran each one. Nothing here is invented.
 */
export const DEMO = {
  repo: 'kortix-factory-demo',
  tickets: [
    { number: 1, title: 'POST /todos with malformed JSON crashes the whole server', state: 'in review' },
    { number: 2, title: 'POST /todos/:id/done returns 200 for a nonexistent todo', state: 'in review' },
    { number: 3, title: 'POST /todos accepts a missing, empty or non-string title', state: 'in review' },
  ],
  /** The reviewer's checks on pull request #6, as it reported them. */
  worker: [
    { kind: 'cmd', text: "curl -X POST /todos -d '{bad'   # on main" },
    { kind: 'out', text: '000 · process exited: SyntaxError at src/server.js:16' },
    { kind: 'cmd', text: "curl -X POST /todos -d '{bad'   # on the fix" },
    { kind: 'ok', text: '400 {"error":"invalid json"} · GET /todos → 200' },
    { kind: 'cmd', text: 'npm test   # 3 consecutive runs' },
    { kind: 'ok', text: '4 pass, 0 fail, each run' },
  ] as Array<{ kind: 'cmd' | 'out' | 'ok'; text: string }>,
  pr: {
    number: 6,
    title: 'fix: return 400 on malformed JSON instead of crashing the server',
    branch: 'kortix/fix-malformed-json-crash',
    additions: 83,
    deletions: 3,
    checks: ['npm run lint · exit 0', 'npm test · 4 pass, 0 fail, 3 runs', 'on main · crash reproduced', 'on the branch · 400, server up'],
  },
};

/** A small, valid kortix.yaml: one agent, what starts it, and the registries it draws on. */
export const MANIFEST = [
  'agents:',
  '  factory:',
  '    prompt_file: agents/factory.md',
  '    skills: [software-factory]',
  '    tools: [lookup_order]',
  '    extensions: [review-gate]',
  '    connectors: [helpdesk]',
  '',
  'triggers:',
  '  - slug: nightly-tests',
  '    on: { cron: "0 0 2 * * *" }',
  '    run: { agent: factory, prompt: "Run the tests. File what fails." }',
  '',
  'skills:',
  '  software-factory: skills/software-factory',
  'tools:',
  '  lookup_order: tools/lookup_order.ts',
  'extensions:',
  '  review-gate: { pi: extensions/review-gate.ts }',
  '',
  'connectors:',
  '  - { slug: helpdesk, provider: http, base_url: https://helpdesk.example.com/api }',
  '',
  'sandbox:',
  '  templates:',
  '    - { slug: dev, dockerfile: .kortix/Dockerfile }',
];

/** What kortix.yaml defines, one line each. `key` is the YAML key. */
export const ENGINE = [
  { term: 'Agents', key: 'agents', body: 'Every agent is a pi coding agent you define: its prompt, model, skills and what it may use. Nothing is granted by default.' },
  { term: 'Triggers', key: 'triggers', body: 'What starts an agent: a schedule, a webhook, a Slack message, an app event.' },
  { term: 'Skills', key: 'skills', body: 'Folders of instructions in your repo. An agent loads one when the work calls for it.' },
  { term: 'Tools', key: 'tools', body: 'Your own tools: a TypeScript file in your repo, registered by name, enabled per agent.' },
  { term: 'Extensions', key: 'extensions', body: 'pi extensions change the agent itself: hooks on its lifecycle, new commands, new behavior. A file in your repo or a pinned npm package.' },
  { term: 'Connectors', key: 'connectors', body: '3,000+ apps in a click, plus MCP, OpenAPI and raw HTTP. Rules decide which calls run and which wait for you.' },
  { term: 'Environment', key: 'sandbox', body: 'A Dockerfile for the sandbox each session runs in: your toolchain, your services, your tests.' },
  { term: 'Secrets', key: 'env', body: 'The file names them. The values stay encrypted in your workspace and reach only the agents you grant.' },
];

/** Names only: the brand kit allows no third-party logos. */
export const TOOLS = ['GitHub', 'Linear', 'Jira', 'Asana', 'Slack', 'Sentry', 'Better Stack', 'Claude Code', 'Codex'];

export const FAQ = [
  { q: 'What is Dosco?', a: 'Cloud agents for your repository, defined in one kortix.yaml: the agents, what starts them, the skills they use and what they may do.' },
  { q: 'What is a factory?', a: 'One agent with its triggers and skills for one team\'s work. Each template can be adapted to your repository by your coding agent.' },
  { q: 'Which coding agents can run the prompt?', a: 'Any agent with a shell on your computer: Claude Code, Codex, Cursor. It follows the setup guide with you and asks before every decision.' },
  { q: 'Which models do the agents use?', a: 'The plan you already have: your Claude or ChatGPT subscription, or any API key you add. It is shared with your workspace, so scheduled runs use it too.' },
  { q: 'Does it work with my existing repository?', a: 'Yes. It reads how the repository builds and tests, and writes an environment the agents use. Your code stays in your GitHub repository.' },
  { q: 'Where do the agents run?', a: 'In isolated E2B cloud sandboxes, in an environment built from your repository. They never point at your staging or production systems.' },
  { q: 'Who approves the work?', a: 'You. Every pull request, post and outbound draft waits for a person until you allow more. Security fixes always wait.' },
  { q: 'How do I turn it off?', a: 'Pause its triggers with one command, or delete its folder under .kortix/.' },
];
