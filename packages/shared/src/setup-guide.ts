/**
 * The one-prompt setup. A developer pastes a prompt into the coding agent on
 * their own computer (Claude Code, Codex, any agent with a shell). That agent
 * fetches the guide from \`<origin>/setup.md\` and does every step with them:
 * sign in, models, a template, the dev environment, secrets, push, webhooks,
 * and one real run.
 *
 * Every prompt and the guide are built for one deployment (\`SetupTarget\`):
 * kortix.com serves the production prompt; dev.kortix.com and a local stack
 * serve prompts and a guide that point at themselves and their own API, so a
 * copied prompt is always testable where it was copied.
 */

/** The Kortix deployment a prompt and the guide point at. */
export interface SetupTarget {
  /** The web origin that serves the guide and the installer, without a trailing slash. */
  origin: string;
  /** The API base the CLI signs in to, without \`/v1\`. */
  apiBase: string;
}

export const PROD_TARGET: SetupTarget = { origin: 'https://kortix.com', apiBase: 'https://api.kortix.com' };

const trim = (url: string) => {
  let out = url.trim();
  while (out.endsWith('/')) out = out.slice(0, -1);
  return out;
};

/**
 * The target of one deployment from its web origin and its backend URL
 * (\`NEXT_PUBLIC_BACKEND_URL\`: absolute or root-relative, with or without \`/v1\`).
 * Missing values fall back to production.
 */
export function setupTarget(origin?: string | null, backendUrl?: string | null): SetupTarget {
  const web = origin ? trim(origin) : PROD_TARGET.origin;
  // Production serves the web app on www.kortix.com too (its APP_URL): the same deployment.
  if (web === PROD_TARGET.origin || web === 'https://www.kortix.com') return PROD_TARGET;
  const backend = backendUrl?.trim() ? trim(backendUrl) : '';
  const absolute = /^https?:\/\//.test(backend) ? backend : backend ? `${web}${backend.startsWith('/') ? '' : '/'}${backend}` : '';
  return { origin: web, apiBase: absolute ? absolute.replace(/\/v1$/, '') : PROD_TARGET.apiBase };
}

const isProd = (target: SetupTarget) => target.origin === PROD_TARGET.origin && target.apiBase === PROD_TARGET.apiBase;

/** The CLI host name of a non-production deployment: \`dev.kortix.com\` → \`dev-kortix-com\`, \`localhost:3000\` → \`localhost-3000\`. */
export function setupHostName(target: SetupTarget): string {
  return target.origin.replace(/^https?:\/\//, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
}

export const guideUrl = (target: SetupTarget = PROD_TARGET) => `${target.origin}/setup.md`;
export const SETUP_GUIDE_URL = guideUrl();
export const FACTORY_GUIDE_URL = `${PROD_TARGET.origin}/factory.md`;

/** An older CLI lacks commands this guide uses, so step 0 always runs the installer. */
const OLD_CLI_NOTE = [
  'Always run the installer, also when `kortix` exists: an older CLI lacks',
  'commands this guide uses. When `kortix onboard --help` does not list `--wait`',
  'afterwards, an older copy is earlier on PATH: `which -a kortix` lists them;',
  'tell the person which one to remove, in one line.',
].join('\n');

/** The CLI's built-in Kortix Cloud host (\`CLOUD_HOST_NAME\` in host-config): every config has it. */
const CLOUD_HOST = 'cloud';

/** Step 0 of the guide: install or update the CLI and point it at this deployment. */
function installBlock(target: SetupTarget): string {
  if (isProd(target)) {
    // The CLI keeps the host it used last: a person who once followed a test or
    // self-hosted guide would otherwise set this repository up there.
    return [
      '```bash',
      `curl -fsSL ${target.origin}/install | bash   # installs the CLI, or updates an older one`,
      'kortix --version',
      `kortix hosts use ${CLOUD_HOST}   # Kortix Cloud, ${target.apiBase}`,
      `kortix hosts current   # must print ${CLOUD_HOST}`,
      '```',
      '',
      'The CLI keeps the host an earlier guide or command chose (a test or',
      `self-hosted deployment). \`kortix hosts use ${CLOUD_HOST}\` points every later command at`,
      'Kortix Cloud.',
      '',
      OLD_CLI_NOTE,
    ].join('\n');
  }
  const host = setupHostName(target);
  return [
    `This guide is served by the Kortix deployment at ${target.origin} (API ${target.apiBase}),`,
    'not production. Point the CLI at it before anything else; every later',
    'command then talks to this deployment.',
    '',
    '```bash',
    `curl -fsSL ${target.origin}/install | KORTIX_CHANNEL=dev bash   # installs the CLI, or updates an older one`,
    'kortix --version',
    `kortix hosts info ${host} >/dev/null 2>&1 || kortix hosts add ${host} --url ${target.apiBase}`,
    `kortix hosts use ${host}`,
    'kortix hosts current   # must print ' + host,
    '```',
    '',
    OLD_CLI_NOTE,
    '',
    'A test deployment may have no Kortix GitHub App. When step 6 asks the person',
    'to install the App and the link does not work, use their own token instead,',
    'with their yes: `gh auth token | kortix onboard --yes --json --github-token -`.',
  ].join('\n');
}

/** Step 8 of the guide: register this deployment's MCP server with the local coding agents and link the skills. */
function agentBlock(target: SetupTarget): string {
  const url = `${target.apiBase}/v1/mcp`;
  return [
    '```bash',
    `command -v claude >/dev/null && claude mcp add --transport http kortix ${url}`,
    `command -v codex >/dev/null && codex mcp add kortix --url ${url} && codex mcp login kortix`,
    'kortix init --force',
    '```',
  ].join('\n');
}

/** The one prompt of the Software Factory: a URL, nothing to install first. */
export const FACTORY_PROMPT = `Add a Kortix software factory to this repository with me.
Follow ${FACTORY_GUIDE_URL} (curl -fsSL ${FACTORY_GUIDE_URL}) step by step.
Ask all your questions in one message. Never print a secret value.`;

/**
 * The public reference repository of each factory: a complete kortix.yaml a
 * setup agent reads and adapts. Onboarding is custom per repository; these are
 * the examples, never copied as is.
 */
export const REFERENCE_REPOS: Record<string, string> = {
  'software-factory': 'https://github.com/kortix-ai/software-factory',
  marketing: 'https://github.com/kortix-ai/marketing-factory',
};

/** Kept for links to a loop's guide; the reference repository is the source an agent adapts. */
export const loopGuideUrl = (id: string, target: SetupTarget = PROD_TARGET) => `${target.origin}/loops/${id}.md`;

/** The prompt of one template: the setup guide, with that template chosen. */
export function loopPrompt(loop: { id: string; name: string }, target: SetupTarget = PROD_TARGET): string {
  const url = guideUrl(target);
  return `Set up the Kortix ${loop.name} on this repository with me.
Read ${url} (curl -fsSL ${url}) and follow it step by step. The template is ${loop.id}.
Ask all your questions in one message. Never print a secret value.`;
}

/** What a person copies. Short on purpose: the guide it points to is versioned and served. */
export function setupPromptFor(target: SetupTarget = PROD_TARGET): string {
  const url = guideUrl(target);
  return `Set up Kortix cloud agents on this repository with me.
Read ${url} (curl -fsSL ${url}) and follow it step by step.
Ask all your questions in one message. Never print a secret value.`;
}

/** The production prompt. */
export const SETUP_PROMPT = setupPromptFor();

/** The prompt for one template: the same as the landing page's (\`loopPrompt\`). */
export function templatePrompt(template: { id: string; name: string }, target: SetupTarget = PROD_TARGET): string {
  return loopPrompt(template, target);
}

/**
 * The prompt for a workspace that exists already and reads \`kortix.yaml\`
 * from \`repository\` on \`branch\`: the setup must push there.
 */
export function setupPrompt(
  workspace?: { repository?: string | null; branch?: string | null },
  target: SetupTarget = PROD_TARGET,
): string {
  const prompt = setupPromptFor(target);
  const repository = workspace?.repository?.trim();
  if (!repository) return prompt;
  const branch = workspace?.branch?.trim() || 'its default branch';
  return `${prompt}
The Kortix workspace exists already: it reads kortix.yaml from ${repository} on ${branch}. Push the setup there.`;
}

/**
 * What a running session sandbox costs, as the guide quotes it. Billing owns the
 * numbers (apps/api/src/platform/providers/compute-rates.ts); an API unit test
 * fails when these drift from it.
 */
export const SANDBOX_RATES = { vcpuHour: 0.0324, memoryGbHour: 0.0108, diskGbMonth: 0.0526 } as const;

/** The hourly cost of a running sandbox of this size, in USD. */
export function sandboxHourlyUsd(cpu: number, memoryGb: number): number {
  return Math.round((cpu * SANDBOX_RATES.vcpuHour + memoryGb * SANDBOX_RATES.memoryGbHour) * 100) / 100;
}

/** The guide for one deployment, served at \`<origin>/setup.md\`. */
export function setupGuide(target: SetupTarget = PROD_TARGET): string {
  return `# Set up Kortix on this repository

The person pasted the setup prompt. You are the coding agent on their
computer. You install the Kortix CLI, sign them in, read their repositories and
the software they use, and offer the Kortix template that fits. After their one
reply you set it up, run it once for real, and show them what it made. Their
part is one reply and the clicks only a person can make.

What they get: agents that run in Kortix cloud sandboxes on a copy of their dev
environment, on their Claude or ChatGPT plan or an API key. A signal starts
each run: a new issue, a failing test, a production error, a signup, a
schedule. The agent ships the work for a person to approve: a pull request, a
ticket, a draft.

There are five templates: Software Factory, Marketing Factory, Sales Factory,
Recruiting Factory and Support Factory (\`kortix templates ls --json\`). Each
one is an agent, its skills and its triggers, ready to fit to a repository.

\`kortix\` is your only tool for the platform. Use \`--json\` for everything you
parse.

## Rules

1. **One message of questions, one reply.** Investigate first (step 2), then
   ask every question in one message (step 3). Each question carries your
   recommended answer. The person's one reply approves the whole plan. After
   it, do not ask again, unless a step fails in a way only the person can
   decide. Never ask what the repository, \`gh\` or \`kortix\` can answer.
2. **Secrets.** Values move only through \`kortix\` (it reads them in-process).
   Never print a secret, never put one in a command argument, never paste one
   into a file. **Never open a file that may hold one**: no \`cat\`, \`head\`,
   \`grep\` with context, or your own file-read tool on \`.env*\`, \`*.keys\`,
   \`.envrc\` or credential files. Reading a file sends its values to your model
   provider. Use the names-only view: \`kortix plan --json\` (\`env\`: every key,
   classed \`local\`, \`remote\` or \`prod\`).
3. **Never point agents at a shared backend.** A name classed \`remote\` or
   \`prod\` is not uploaded. The agents' dev environment runs locally and
   throwaway in the sandbox.
4. **Install, then adapt.** \`kortix templates add\` installs a template. You
   then fit it to this repository: its tracker, its commands, its channels.
   The public reference repositories in the plan are finished examples to
   read. Never copy files from them.
5. **Verify, don't assume.** A step is done when \`kortix doctor --loops\` or a
   real run proves it.
6. **Plain words.** Every message to the person leads with the result or with
   the one thing you need from them. Name the real thing: the repository, the
   file, the command, the count, the link. Short sentences, one fact each. No
   filler, praise, hype, emoji or exclamation marks. Never write "seamless",
   "robust", "leverage", "powerful", "unlock", "empower", "streamline",
   "supercharge", "effortless", "magic", "game-changer", "dive in", "let's",
   "I'd be happy to", "great", "simply", "just" or "exciting". Show what the
   agents will do in this repository, not what Kortix is.
7. **Be brief.** One line per step while you work. Do not print what you
   investigated: no map, no inventory, no list of ideas. A finding reaches the
   person only as one line of the step 3 message or of the final report. The
   step 3 message has at most 40 lines, the final report at most 15.
8. **A connector for every app.** Every app you found gets a Kortix connector
   when the catalog has one, whether a loop calls it or not: the agents then
   reach all of the team's software. The person signs in once on the setup
   page and copies no key. Ask for an API token only for an app no connector
   serves, or for a token the template's steps name (the GitHub token).
9. **Keep the reply.** Do what the person chose. When a choice cannot work as
   chosen, only the person decides the change: say why in one line, give your
   fix and wait for the answer. Never swap a choice without saying so.
10. **The setup page is the person's.** Every sign-in (the model plan, a
    connector, Slack, the GitHub App) and every pasted token happen there, in
    the page \`onboard\` opens. Never sign in, connect or click for the person,
    in the terminal or in a browser.

## 0. Install

${installBlock(target)}

## 1. Sign in and see the plan

\`\`\`bash
kortix whoami          # signed in? if not:
kortix login           # opens the browser: "click Authorize in the browser tab it opened"
kortix plan --json     # the deterministic baseline, names only
\`\`\`

\`kortix plan\` reports the repository (GitHub origin, default branch, monorepo
layout, clean or dirty), the stack (runtimes, package managers, services, dev,
test and end-to-end commands, CI), every env key by class, the software it
found (\`integrations\`: each with a category and its evidence; about 90
products are known), the credentials it could not name
(\`unrecognized_services\`: a key prefix each), the MCP servers the repository's
coding tools already use (\`mcp_servers\`, names only), the Kortix state
(workspace, connectors, Slack, models), a dev-environment proposal and the
reference repositories.

## 2. Investigate, without asking

The plan is the floor, not the ceiling. Investigate for minutes, not hours.
Ask nothing and print nothing in this step: everything you find feeds the one
message of step 3.

1. **This repository.** Read it the way a new engineer would: \`AGENTS.md\`,
   \`CLAUDE.md\`, \`CONTRIBUTING.md\`, the README, CI workflows, the scripts the
   team runs. Note every rule that conflicts with agents shipping work (for
   example "push to main"). For a monorepo, note which apps exist and how
   each one starts and tests. Note the skills and agents the team has
   already: every folder with a \`SKILL.md\`
   (\`find . -name SKILL.md -not -path '*/node_modules/*'\`: \`.claude/skills/\`,
   \`.agents/skills/\`, \`skills/\`) and every \`.claude/agents/<name>.md\`. The
   setup reuses them (step 4).
2. **The other repositories.** \`gh repo list <owner> --limit 100 --json name,description,pushedAt,isArchived\`
   for the owner of this repository's origin, plus the repositories this one
   names (submodules, workflow \`uses:\` of the same owner, links in the docs).
   Note the ones pushed in the last 90 days and what each one is. Then name
   the shape: one repository (a monorepo is one: several apps, one
   repository), or one product over several repositories (a web app, an API,
   services, each in its own). The shape decides where Kortix lives (step 3).
   Check the person's rights on each code repository:
   \`gh api repos/<owner>/<repo> --jq .permissions\`. \`onboard\` creates the
   GitHub webhooks with their \`gh\`, which needs \`admin\`. Without it, say so on
   the \`Found:\` line and name who can: an owner of the repository runs
   \`kortix doctor --loops --fix\` once, or the triggers poll instead.
3. **The software.** Start from the plan's \`integrations\` (each has a
   category and its evidence), \`unrecognized_services\` and \`mcp_servers\`.
   Add what you find yourself: SDK imports, webhook handlers, secret names in
   CI workflows, deploy configs, links in the docs. For each one note the
   signal it gives (a new error, a new ticket, a signup) and the action it
   allows (a reply, a comment, a query).
4. **Where context lives.** The docs folder or site, the wiki, ADRs and
   runbooks, the tracker and its labels, the changelog, and what the
   repository links to outside itself (Notion, Google Drive, Confluence,
   Figma).
5. **The template that fits.** \`kortix templates ls --json\` lists the
   templates and what each one does. Match them to what you found. A code
   repository with tests and a tracker fits the Software Factory. A website,
   docs or a changelog fits the Marketing Factory. Signups and a CRM fit the
   Sales Factory. An ATS fits the Recruiting Factory. A help desk fits the
   Support Factory. Recommend the one with the most evidence and offer at most
   one more. When the prompt or the steps above this guide name a template,
   that one is chosen.
6. **Its steps and questions.** \`kortix templates onboard <id> --steps\`
   prints the recommended template's own steps. They mark questions with
   **Ask**. Collect each one now, with your recommended answer: it goes into
   the step 3 message. Never ask it where it appears.
7. **What it runs here.** From the template's sources, pick the 2 to 4 that
   fit the evidence, most valuable first. Each one is a signal, what the agent
   ships, who approves it, and the evidence ("42 open issues labeled bug and a
   test suite: each bug becomes a pull request with test output"). Keep the
   other ideas for the final report, under "later". No template fits: offer 2
   to 4 loops of your own in the same form.
8. **What it needs to run.** The sandbox runs the dev stack and its tests,
   never production traffic: size it for the heaviest command, usually the
   build or the test suite. Start from the plan's \`dev_environment.resources\`
   (memory first: 4 GB, more for browser tests, Docker, each service and a
   monorepo; CPU follows memory). Raise it for what the plan does not see: a
   Next.js or webpack production build (6 GB or more), a JVM or Gradle build,
   a mobile build, a local model, a \`--max-old-space-size\` in the scripts,
   or the CI runner size the team already pays for (\`runs-on\`).

## 3. One message of questions, one reply

Send the person one message in this shape. Write it as plain text, also in
Claude Code: a question tool holds fewer questions and can hide the findings.

\`\`\`text
Kortix setup for <owner>/<repo>

<What the agents will do here, end to end, in one or two sentences with the
 real names: "Each GitHub issue labeled kortix becomes a pull request with
 test output and a recording. Sentry errors become tickets first. You merge.">

Found: <the stack, and how it runs and tests>
       <the software the template will use>
       <anything that needs their eye: a production value in an env file,
        a rule that conflicts with the agents>

1. Template:
   a) <name> (recommended): <signal> -> <what it ships>, <who approves>
   b) <name>: <signal> -> <what it ships>, <who approves>
   c) none: my own loops
2. Start with (pick any):
   a) <source>: <signal> -> <output>, <approver> (recommended)
   b) <source>: <signal> -> <output>, <approver>
3. <question>?
   a) <answer> (recommended)  b) <answer>  c) <answer>
...
Defaults: <every other decision, with the answer you will use>.

Reply "go" to take every recommended answer, or "go" with changes:
"go, 1b, 2ac, 5: Linear".
\`\`\`

The opening sentence and \`Found:\`:

- The opening says what the agents will do in this repository, from signal to
  result, with the real names. It is the first thing the person reads.
- \`Found:\` has at most 4 lines, each one a fact that changes a decision or
  needs their eye. Everything else stays out.

The questions:

- **At most 8**, numbered. Each one fits in 3 lines and has a recommended
  answer. A free-text answer (a URL, competitor domains, an ICP, a rubric)
  gets your draft as its recommended answer; the person corrects it.
- **Only decisions the person owns.** Pick from this list, in this order,
  and leave out a question the evidence settles:
  1. the template (settled when the prompt named one);
  2. what it starts with: its sources, each with its signal, output and
     approver;
  3. where work lands: the tracker or the system of record;
  4. the software to connect as Kortix connectors: every app you found that
     the catalog has, whether a loop calls it or not (rule 8). One line that
     names them, recommended: all, and ends with "Anything missing?" so the
     reply can add one. When the plan shows a workspace, check each app first
     with \`kortix connectors catalog <name> --json\` and leave out an app
     with no entry. Before sign-in, an MCP server's tool list in the catalog
     is a directory's copy and can be out of date: never drop a connector for
     a tool it seems to lack. The template's steps name the connector to use;
  5. Slack, unless the plan shows it connected. Recommend yes: the team then
     gives the agents work by mentioning @Kortix in a channel or in a direct
     message, and the reply comes back in the same thread. The answer may name
     channels for it to join (\`#eng\`); none is needed, a direct message works
     without one. One Slack workspace runs one Kortix workspace: when theirs
     already runs another, adding it here moves it. Say so in the question;
  6. the models: the person's Claude plan, their ChatGPT plan, or an API
     key; the reviewer on the strongest model;
  7. where Kortix lives, from the shape you named in step 2, with the
     workspace name:
     a) this repository (recommended for one repository or a monorepo):
        \`kortix.yaml\`, \`agents/\` and \`skills/\` go next to the code, the
        workspace runs on this GitHub repository, and the team's own skills
        and agents are reused where they are. Ask how the files land: a
        commit on the default branch (recommended when the team pushes
        there) or a pull request they merge;
     b) a new repository Kortix hosts (recommended for a product over
        several repositories): the agents reach each code repository on
        GitHub;
  8. the template's questions from step 2;
  9. a repository rule that conflicts with the agents: which one wins;
  10. the task for the real run in step 7, from what you found.
- **More than 8:** keep the 8 with the largest effect. Put every other
  decision, with the answer you will use, on the \`Defaults:\` line: the env
  names to upload (every \`local\` name the app reads; never a \`remote\` or
  \`prod\` one), the sandbox size with its cost ("4 vCPU, 8 GB, 30 GB disk:
  about $${sandboxHourlyUsd(4, 8).toFixed(2)} an hour while a session runs"), the Kortix
  rule in \`AGENTS.md\` (default: add it).
- **A gap is a question only when a chosen source needs it.** An
  \`unrecognized_services\` prefix or an empty category becomes one question
  with likely answers ("Tickets: a) GitHub Issues (recommended) b) Linear
  c) Jira"). Otherwise leave it out.
- **Never** ask one item at a time or for a secret value. The software line's
  "Anything missing?" is the one open question.

After the reply:

- The reply approves the plan. Do not show the plan again and do not ask a
  second round.
- A question the reply leaves open gets its recommended answer: say so in one
  line.
- The reply picks another template: read its steps
  (\`kortix templates onboard <id> --steps\`) and go on. Its questions take
  your recommended answers; name them in one line. No second round.
- A new thing in the reply (a custom loop in their words, another tool): add
  it when it fits, else put it in the final report under "later".
- From here the person only acts: a sign-in, an Authorize click, a token
  pasted into an intake link. Give each link once. Give the links that are
  ready at the same time in one message.

## 4. Write the configuration

Where you work follows the step 3 answer "where Kortix lives".

**In this repository** (one repository or a monorepo). The configuration goes
next to the code, at the repository root (a monorepo's root, never one app's
folder), and the workspace runs on this GitHub repository: every session
starts from it. Work in this repository on its default branch. When the person
has uncommitted work here, never commit, stash or discard it: work in
\`git worktree add ../<repo>-kortix <default branch>\` instead. Reuse what the
repository has, where it is, and never copy or move it:

- each skill folder you found in step 2, by its path:
  \`skills: { <name>: .claude/skills/<name> }\`. The folder's last segment is
  the name: lowercase words joined by \`-\`, not starting with \`kortix-\`;
- each \`.claude/agents/<name>.md\` as an agent's prompt:
  \`agents.<name>.prompt_file: .claude/agents/<name>.md\` (its frontmatter is
  ignored, so give the agent its own \`tools\` and \`model\`);
- the root \`AGENTS.md\` (else \`CLAUDE.md\`): every session reads it as it is.

A template: \`kortix templates add <id> --json\` (the repository and branch come
from \`origin\`). It refuses a file that exists and differs: rename the
template's file, never overwrite the team's.

**In a new repository** (a product over several repositories). Work in a
folder beside this one: \`kortix workspaces clone <workspace_id>
../<repo>-kortix\` when the plan shows the workspace, else a new folder with
\`git init\`. Run every later \`kortix\` command there. The code stays where it
is; the agents reach each code repository on GitHub. Copy the skills you found
into \`skills/<name>/\` there, so the agents have them too. A template:
\`kortix templates add <id> --repo <owner/repo> --branch <default branch>
--json\`, with the main code repository named.

Both use the layout of every workspace repository: \`kortix.yaml\` at the root,
each agent's prompt in \`agents/<name>.md\` (or the file it already has), each
skill in \`skills/<name>/\` (or the folder it already has). A template adds
\`<id>.yaml\` (which \`kortix.yaml\` imports) and its settings JSON at the root.
Never write a \`.kortix/\` folder: it holds only the CLI's local state.

Then follow the template's steps: write its settings
JSON from the reply, turn on the triggers of the chosen sources and turn off
the rest. No template: write the agents and triggers yourself, in the same
layout. Declare every app you found under \`connectors:\` (rule 8), whether a
loop calls it or not, with the entry the template's steps give, else the
catalog's: \`onboard\` turns each one into a sign-in row on the setup page. An
app reached only through a secret gets no row. Slack, when the reply says yes, is this entry in \`kortix.yaml\`, the one
Kortix writes itself when Slack connects; \`onboard\` turns it into the "Add to
Slack" row:

\`\`\`yaml
connectors:
  - slug: kortix_slack
    name: Slack
    provider: channel
    platform: slack
\`\`\`

Then write \`kortix.yaml\` with \`env.required\` and \`env.optional\` listing every
secret the loops use and every env name the app reads to install, start and
test (the plan's \`env\` names classed \`local\`; step 7 proves none is missing),
the sandbox \`Dockerfile\` at the root (a Debian-family base, the code
repository's runtimes at their pinned versions, git and gh, no \`COPY\` from
the repository), and the template's \`cpu\`, \`memory\` and \`disk\` from step 2:
whole numbers, memory and disk in GB (cpu 1–32, memory 1–128, disk 1–500).
A running sandbox costs $${SANDBOX_RATES.vcpuHour} per vCPU-hour plus $${SANDBOX_RATES.memoryGbHour} per GB-hour of
memory, billed per second; a stopped one costs only its disk ($${SANDBOX_RATES.diskGbMonth} per
GB-month). Too small crashes the tests; too large bills every session for
room it never uses. Step 7 measures the real need.

Write the \`dev-environment\` skill in \`skills/dev-environment/\` (or the folder
the team's own has). It starts with how a session gets the code, because a
session's \`/workspace\` starts empty: in this repository, \`kortix workspaces
clone\` (the workspace repository is the code); in a new repository, the
GitHub clone with the token the template names. Then the install, start and
test commands. A loop that works on the code clones it from GitHub with the
GitHub token its template names (\`FACTORY_GITHUB_TOKEN\` for the Software
Factory), so that token is a required secret. Then:

\`\`\`bash
kortix validate
\`\`\`

Fix every error and warning in the files you wrote. Two rules save a round:

- Give every agent you add a \`tools\` list (or \`"*"\`). An agent without one
  trips a deprecation warning.
- Every GitHub webhook trigger filters on
  \`body.repository.full_name: <owner>/<repo>\`, the code repository (the
  templates carry it). \`onboard\` and \`doctor\` then put the webhooks and
  labels there, and an event from any other repository never starts a run.

Commit the Kortix files before step 6: \`onboard\` refuses any other
uncommitted change, and the workspace reads the default branch. In this
repository, the step 3 answer decides how they land:

- **A commit:** commit only the Kortix files on the default branch. \`onboard\`
  pushes it. A protected branch refuses the push: say so in one line and
  open a pull request instead.
- **A pull request:** \`git switch -c kortix/setup\`, commit, push,
  \`gh pr create\`. When the person has merged it, switch to the default
  branch, pull, and go on. Never point the workspace at \`kortix/setup\` to
  start before the merge: many repositories delete a merged branch
  (\`delete_branch_on_merge\`), and the workspace would then read a branch
  that no longer exists.

## 5. Connect the models

The setup page (step 6) asks for a model first when the workspace has none:
the person picks their Claude or ChatGPT plan, or adds a key, there (rule
10). Connect no model from the terminal.

## 6. Do it

\`\`\`bash
kortix onboard --yes --json --wait \\
  [--env-file <file> --only <A,B>]... \\
  [--channels <a,b>] \\
  --repo <owner/repo> [--name "<workspace name>"]
\`\`\`

The first run creates the workspace. \`--name\` is its display name (default:
\`project.name\` in \`kortix.yaml\`, else the folder name): use the name from
step 3, for example "Acme Loops". \`--repo\` is the code repository on GitHub:
always pass it. \`--channels\` takes the Slack channels the reply named; leave
it out when it named none.

**The icon.** Once \`ship\` has linked the folder, give
the workspace an icon that says what the product is: \`kortix workspaces set
--glyph <Name>:<color>\`. Pick the name from \`kortix workspaces glyphs --json\`,
the icons Kortix supports: the one closest to what the product does (\`Phone\`
for a calling tool, \`ShoppingCart\` for a shop), never one from the \`Kortix\` or
\`Brand\` group. The color is the product's brand color from the code
repository as \`#rrggbb\`: \`theme_color\` in the web manifest, else the primary
color of its CSS or Tailwind theme. No brand color found: one of the list's
\`colors\`.

It runs in phases, each skipping what is done: \`validate\`, \`ship\` (create the
workspace and push its repository; it refuses a dirty tree), \`secrets\`
(approved names, generated webhook secrets, one intake link for the rest,
the GitHub token included), \`webhooks\` (the GitHub repository webhooks and
labels the triggers need, through the person's \`gh\`), \`slack\` (waits for
Slack, then the bot joins the channels), \`connectors\`, \`sandbox\` (build every
image and wait; a first build takes 5 to 10 minutes and prints nothing in
\`--json\` mode), \`doctor\`.

**The setup page.** Every step only the person can do (a model, a connector
sign-in, a secret such as the GitHub token, Slack) is one row on
\`<web>/workspaces/<id>/setup\`. \`onboard\` opens it in their browser before the
image build and prints \`setup_url\`. Before you run it, say one line: "The
setup page opens in your browser: connect what it lists. I continue when every
row is done." Never print those links in the terminal. \`--wait\` keeps the run
going until the page shows every row done, then finishes the phases that
waited.

Run the command as written. Never add \`--no-open\` and never drop \`--wait\`:
the page is where the person makes every click (rule 10). Wait for
\`onboard\` to exit before you end your turn: ending the turn can stop a
command that runs in the background, and a question to the person never waits
on a running \`onboard\`.

A repository webhook that already sends the same event to another Kortix
workspace is left in place and reported in the \`webhooks\` detail. Tell the
person: two workspaces would act on the same event. They pick one; delete the
other hook with the command \`kortix doctor --loops\` prints.

A source that is off needs nothing: a disabled Slack trigger asks for no Slack
connection.

In this repository, \`ship\` links the workspace to it through the Kortix GitHub
App. The first run asks for the App's install on this repository: a
\`github_app_install\` action with its link.

Exit 0 is done and green. Exit 4: steps are left. A \`user_action\` the page
does not show (\`/invite\` the bot to a private Slack channel, install the
GitHub App) goes to the person once, in one message. \`--wait\` timed out
(\`next\` says what the page still lists): tell the person in one line, then
run the same command again. Exit 1: read the failed phase's \`detail\`, fix
it, run again.

## 7. Prove it, and loop until it works

\`\`\`bash
kortix doctor --loops --json        # every check of what kortix.yaml declares
kortix doctor --loops --fix --json  # re-runs the phase a red line names
\`\`\`

Pass the same \`--repo <owner/repo>\` you gave \`onboard\`, if any.

Loop until \`ready: true\`. A green doctor proves the configuration, not the
dev environment: the image is built, but nothing has run the app in it yet.

**Prove the dev environment.** Start a session on the agent that works on the
code, so it runs on that agent's \`sandbox\` (else \`sandbox.default\`): the
image the \`Dockerfile\` built. A session without \`--agent\` runs My Kortix on
another image and proves nothing.

\`\`\`bash
kortix sessions new --agent <agent> --json --prompt "<the check>"   # capture session_id
kortix sessions wait-for <session_id> --timeout 1800 --json        # until the turn ends
kortix sessions log <session_id> --json --limit 200                # the real tool output
\`\`\`

The check, as the prompt: "Load the dev-environment skill and follow it: get
the code as it says, run its install, start and test commands, and report each
command with its exit code. Start the app, open it with agent-browser, take a
snapshot and say what the page shows. Change nothing in the repository.
Measure the machine too: print \`nproc\`, \`free -m\` and \`df -m /\` first; while
the install, build and tests run, sample used memory and used disk every 2
seconds; report both peaks, how long the tests took, and any process killed
for memory (exit 137, or \`oom\` in \`dmesg\`)."

Judge from the log's \`tool_call\` blocks (\`result.content[].text\` is the real
output), never from the agent's summary. It passes when every command exits 0,
the tests pass (a test that fails on the default branch too may fail: name
it), and the snapshot shows the app, not an error page. A failure is yours to
fix, and the person waits for none of it:

- a missing runtime, system package or service: the \`Dockerfile\`;
- a wrong or missing command: the \`dev-environment\` skill;
- a missing env name: \`env.required\`, then its value (a \`local\` value
  through \`kortix env push\`, else a row on the setup page);
- too little memory or disk: the template's resources.

Then size the sandbox from the measured peaks, never from a guess:

- killed for memory, or peak memory above 80 % of the size: one step up
  (memory × 1.5, rounded up; cpu 2 under 8 GB, 4 under 12 GB, else 8);
- peak disk above 80 %: add half again;
- the tests take over 10 minutes and the CPU was busy: double the cpu;
- after a pass with peak memory under 40 % and peak disk under 50 %: one
  step down (memory ÷ 1.5, rounded up), then one more pass, since every
  session pays for the size. Never go under 2 vCPU, 4 GB and 20 GB: the
  agent and its browser share the machine with the app.

Resize with \`kortix sandboxes update <slug> --cpu <n> --memory <gb> --disk
<gb>\`. A new size rebuilds the image. Write the final size and the measured
peaks into the \`dev-environment\` skill, so the next change to the stack knows
its headroom.

Commit, run \`kortix onboard --yes --json --wait\` again (it ships and rebuilds
the image), and run the check in a new session. Loop until it passes. When your
harness has subagents, give this loop to one: the logs are long, and your
thread keeps the person's context.

Then one real run, the cheapest one the factory has:
for the Software Factory, file the task the person approved in step 3 and
label it. The label starts the run: follow it with \`kortix triggers runs\`,
fire a trigger by hand only when the template's steps say so, and wait for the
pull request. Show it to the person: the summary, the commands with their real
output, the demo when the change is visible. Nobody merges it but them.

## 8. Wire this computer's coding agents

So the person can run, change and add loops by talking to the agent they
already use. Tell them each thing you add.

${agentBlock(target)}

- The MCP server lets a coding agent start Kortix sessions, read their
  progress, run commands in a session's sandbox and call the workspace's
  connectors, as the person, with their permissions. The first call opens a
  consent page in the browser. A coding agent loads a new MCP server at its
  next start: say so.
- \`kortix init --force\` runs in the repository that holds \`kortix.yaml\`. It
  links every skill \`kortix.yaml\` registers where each local tool reads
  skills (never committed). An \`AGENTS.md\` the repository already has is
  kept: it gets one marked Kortix section at the end. A code repository
  without \`kortix.yaml\` gets the MCP server and the rule below, nothing else.
- Unless the person said no in step 3, add this rule to the repository's \`AGENTS.md\` (and
  \`CLAUDE.md\` when it exists): "This repository runs Kortix loops, defined
  in \`kortix.yaml\`. To reach an outside tool, use the Kortix connectors
  (\`kortix connectors\` or the Kortix MCP server) before any local
  credential. To add or change a loop, edit \`kortix.yaml\`, run \`kortix
  validate\`, then \`kortix ship\`."
- Use the CLI for setup and scripts, the MCP server in conversation. Both
  reach the same workspace.

## 9. Hand over

Show the result first, then how to use it. At most 15 lines:

1. What the real run made: the pull request, ticket or draft, its link, the
   signal that started it, and how long it took. Then what the dev-environment
   check proved: install, the tests (passed of total) and the app in the
   browser, and the sandbox size with its peaks and its cost per hour.
2. What runs now: one line per trigger (what starts it, what it ships, who
   approves) and where work lands.
3. How to start work by hand: the label to add, or
   \`kortix triggers fire <slug>\`. With Slack connected, first one task to send
   in Slack, a sentence the person can paste into a direct message to @Kortix
   or a channel it joined ("@Kortix why did the last deploy fail?").
4. Three things to ask this agent next, each one sentence the person can
   paste, from what you found ("add a loop that turns Sentry errors into
   tickets").
5. Where to watch (the workspace link) and what you wired on this computer
   (the MCP server, the skills).
6. The answers you took by default, the ideas kept for later, and anything
   still open.
`;
}

/** The production guide. */
export const SETUP_GUIDE = setupGuide();
