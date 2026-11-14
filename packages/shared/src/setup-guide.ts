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
  if (web === PROD_TARGET.origin) return PROD_TARGET;
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

/** Step 0 of the guide: install the CLI and, off production, point it at this deployment. */
function installBlock(target: SetupTarget): string {
  if (isProd(target)) {
    return ['```bash', `command -v kortix || curl -fsSL ${target.origin}/install | bash`, 'kortix --version', '```'].join('\n');
  }
  const host = setupHostName(target);
  return [
    `This guide is served by the Kortix deployment at ${target.origin} (API ${target.apiBase}),`,
    'not production. Point the CLI at it before anything else; every later',
    'command then talks to this deployment.',
    '',
    '```bash',
    `command -v kortix || curl -fsSL ${target.origin}/install | KORTIX_CHANNEL=dev bash`,
    'kortix --version',
    `kortix hosts info ${host} >/dev/null 2>&1 || kortix hosts add ${host} --url ${target.apiBase}`,
    `kortix hosts use ${host}`,
    'kortix hosts current   # must print ' + host,
    '```',
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

/** The one prompt of one factory: read its reference repository, adapt it, follow the setup guide. */
export function loopPrompt(loop: { id: string; name: string }, target: SetupTarget = PROD_TARGET): string {
  const reference = REFERENCE_REPOS[loop.id];
  const read = reference ? `Read ${reference} and adapt it to this repository.\n` : '';
  return `Add a Kortix ${loop.name.toLowerCase()} to this repository with me.
${read}Set it up with the Kortix CLI, following ${guideUrl(target)} step by step.
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

/**
 * The prompt for one template. The CLI carries the template's onboarding
 * (\`kortix templates onboard <id>\`), so it always matches the installed version.
 */
export function templatePrompt(template: { id: string; name: string }, target: SetupTarget = PROD_TARGET): string {
  return `Set up the Kortix ${template.name} on this repository with me.
Install the Kortix CLI if it is missing (curl -fsSL ${target.origin}/install | bash), then run \`kortix templates onboard ${template.id}\` and follow what it prints, step by step.
Ask all your questions in one message. Never print a secret value.`;
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

/** The guide for one deployment, served at \`<origin>/setup.md\`. */
export function setupGuide(target: SetupTarget = PROD_TARGET): string {
  return `# Set up Kortix on this repository

The person pasted a prompt like "Add a Kortix software factory to this
repository with me". You are the coding agent on their computer. From here you
do everything: install the Kortix CLI, sign them in (one click in their
browser), investigate their repositories and the software they use, ask
every question in one message, write their \`kortix.yaml\` by adapting a
reference repository, loop until \`kortix doctor --loops\` is green and one
real run worked, and wire their local coding agents to Kortix. Their part is
one reply to your questions and a few clicks only a person can make.

When you are done, agents run 24/7 in Kortix cloud sandboxes on a copy of their
dev environment, on their Claude or Codex plan or an API key, started by the
signals the plan named (GitHub issues, failing tests, errors, Slack, schedules).

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
4. **Adapt, never copy.** A reference repository is an example. The
   person's \`kortix.yaml\` fits their repository: their tracker, their
   commands, their channels.
5. **Verify, don't assume.** A step is done when \`kortix doctor --loops\` or a
   real run proves it.
6. **Be brief.** One line per step while you work. Do not print what you
   investigated: no map, no inventory, no list of ideas. A finding reaches the
   person only as one line of the step 3 message or of the final report. The
   step 3 message has at most 40 lines, the final report at most 15.

## 0. Install

${installBlock(target)}

## 1. Sign in and see the plan

\`\`\`bash
kortix whoami          # signed in? if not:
kortix login           # opens the browser: "click Authorize in the tab that just opened"
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
   each one starts and tests.
2. **The other repositories.** \`gh repo list <owner> --limit 100 --json name,description,pushedAt,isArchived\`
   for the owner of this repository's origin, plus the repositories this one
   names (submodules, workflow \`uses:\` of the same owner, links in the docs).
   Note the ones pushed in the last 90 days and what each one is.
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
5. **The reference repositories.** \`recommendation.references\` in the plan
   lists them. Read each one's \`README.md\`, \`ADAPTING.md\`, \`kortix.yaml\` and
   \`.kortix/\` now. Every loop is a part you can take on its own. The Software
   Factory has intake from issues, errors, logs and feedback, a worker that
   opens pull requests with proof, and a reviewer. The Marketing Factory has
   the changelog from merged pull requests, blog and social drafts, search
   reports and a brand skill. When the prompt names one reference, that one
   is the starting point; the other is still a source of parts.
6. **The template's questions.** \`ADAPTING.md\` and a template's own steps
   (printed above this guide by \`/factory.md\` and \`kortix templates
   onboard\`) mark questions with **Ask**. Collect every one now, with your
   recommended answer. Each one goes into the step 3 message; never ask it
   where it appears.
7. **The loops to offer.** From what you found, pick 2 to 4 loops, most
   valuable first. Each one is a signal, what the agent ships, who approves
   it, and the evidence that it fits ("42 open issues labeled bug and a test
   suite: bug fixes as pull requests"). Keep the other good ideas for the
   final report, under "later".

## 3. One message of questions, one reply

Send the person one message in this shape. Write it as plain text, also in
Claude Code: a question tool holds fewer questions and can hide the findings.

\`\`\`text
Kortix setup for <owner>/<repo>

Found: <the stack, and how it runs and tests>
       <the software the loops would use>
       <anything that needs their eye: a production value in an env file,
        a rule that conflicts with the loops>

1. Loops to start (pick any):
   a) <name>: <signal> -> <output>, <approver> (recommended)
   b) <name>: <signal> -> <output>, <approver>
2. <question>?
   a) <answer> (recommended)  b) <answer>  c) <answer>
...
Defaults: <every other decision, with the answer you will use>.

Reply "go" to take every recommended answer, or "go" with changes:
"go, 1ab, 3c, 5: Linear".
\`\`\`

The questions:

- **At most 8**, numbered. Each one fits in 3 lines and has a recommended
  answer. A free-text answer (a URL, competitor domains, an ICP, a rubric)
  gets your draft as its recommended answer; the person corrects it.
- **Only decisions the person owns.** Pick from this list, in this order,
  and leave out a question the evidence settles:
  1. the loops to start: signal, output and approver of each;
  2. where work lands: the tracker or the system of record;
  3. the software to connect as Kortix connectors (one line: connect these,
     leave out those). When the plan shows a workspace, check each app first
     with \`kortix connectors catalog <name> --json\` and leave out an app
     with no entry;
  4. the models: the person's Claude plan, their ChatGPT plan, or an API
     key; the reviewer on the strongest model;
  5. where \`kortix.yaml\` lives (this repository, or its own private
     repository so the code gets no file) and the workspace name;
  6. the template's questions from step 2;
  7. a repository rule that conflicts with the loops: which one wins;
  8. the task for the real run in step 7, from what you found.
- **More than 8:** keep the 8 with the largest effect. Put every other
  decision, with the answer you will use, on the \`Defaults:\` line: the env
  names to upload (only \`local\`), the Slack channels, the Kortix rule in
  \`AGENTS.md\` (default: add it).
- **A gap is a question only when a chosen loop needs it.** An
  \`unrecognized_services\` prefix or an empty category becomes one question
  with likely answers ("Tickets: a) GitHub Issues (recommended) b) Linear
  c) Jira"). Otherwise leave it out.
- **Never** ask one item at a time, an open "what else do you use?", or for a
  secret value.

After the reply:

- The reply approves the plan. Do not show the plan again and do not ask a
  second round.
- A question the reply leaves open gets its recommended answer: say so in one
  line.
- A new thing in the reply (a custom loop in their words, another tool): add
  it when it fits, else put it in the final report under "later".
- From here the person only acts: a sign-in, an Authorize click, a token
  pasted into an intake link. Give each link once. Give the links that are
  ready at the same time in one message.

## 4. Write the configuration

Adapt the reference into this repository (or the config repository): write
\`kortix.yaml\` with \`env.required\` and \`env.optional\` listing every secret the
loops use, the \`.kortix/<factory>/\` folder, the sandbox \`Dockerfile\` (a
Debian-family base, the repository's runtimes at their pinned versions, git and
gh, no \`COPY\` from the repository), the template's \`cpu\`, \`memory\` and \`disk\`
from the plan's \`dev_environment.resources\` (a sandbox too small for the dev
stack crashes the tests), and the \`dev-environment\` skill. Then:

\`\`\`bash
kortix validate
\`\`\`

Fix every error and warning in the files you wrote. Two rules save a round:

- Give every agent you add a \`tools\` list (or \`"*"\`). An agent without one
  trips a deprecation warning.
- When \`kortix.yaml\` lives in its own repository, add
  \`body.repository.full_name: <owner>/<repo>\` to the \`filter\` of every
  GitHub webhook trigger. It names the code repository in code: \`onboard\`
  and \`doctor\` then put the webhooks and labels there, and an event from any
  other repository never starts a run.

## 5. Connect the models

Connect what the person picked in step 3.

- **Claude Pro or Max:** \`kortix providers login claude --start --share workspace --json\`;
  give the person the \`authorize_url\`; they paste the code back;
  \`kortix providers login claude --flow <flow_id> --code <code> --share workspace\`.
- **ChatGPT Plus or Pro:** \`kortix providers login openai\` in the background;
  give the person the link and the code it prints.
- **An API key:** \`kortix providers set <provider>\`; the person types the key.

## 6. Do it

\`\`\`bash
kortix onboard --yes --json \\
  [--env-file <file> --only <A,B>]... \\
  [--channels <a,b>] [--connect <slug,...>] \\
  [--name "<workspace name>"] [--repo <owner/repo>] [--github-token -]
\`\`\`

The first run creates the workspace. \`--name\` is its display name (default:
\`project.name\` in \`kortix.yaml\`, else the folder name): use the name from
step 3, for example "Acme Loops". \`--repo\` is the code repository for the
webhooks when \`kortix.yaml\` lives elsewhere and its triggers carry no
\`body.repository.full_name\` filter.

It runs in phases, each skipping what is done: \`validate\`, \`ship\` (link and
push; it refuses a dirty tree), \`secrets\` (approved names, generated webhook
secrets, one intake link for the rest), \`webhooks\` (the GitHub repository
webhooks and labels the triggers need, through the person's \`gh\`), \`slack\`
(connect link, the bot joins the channels), \`connectors\` (a sign-in link each),
\`sandbox\` (build every image and wait; a first build takes 5 to 10 minutes
and prints nothing in \`--json\` mode: tell the person before you start),
\`doctor\`.

A repository webhook that already sends the same event to another Kortix
workspace is left in place and reported in the \`webhooks\` detail. Tell the
person: two workspaces would act on the same event. They pick one; delete the
other hook with the command \`kortix doctor --loops\` prints.

A source that is off needs nothing: a disabled Slack trigger asks for no Slack
connection.

Exit 0 is done and green. Exit 4 means \`user_actions\` are left: give the person
all of them in one message, each exactly once, with its link (install the GitHub App, Allow in Slack,
sign in to a connector, paste a token, \`/invite\` the bot to a private channel).
When they say it is done, run \`kortix onboard --yes --json\` again. Exit 1: read
the failed phase's \`detail\`, fix it, run again.

## 7. Prove it, and loop until it works

\`\`\`bash
kortix doctor --loops --json        # every check of what kortix.yaml declares
kortix doctor --loops --fix --json  # re-runs the phase a red line names
\`\`\`

Pass the same \`--repo <owner/repo>\` you gave \`onboard\`, if any.

Loop until \`ready: true\`. Then one real run, the cheapest one the factory has:
for the Software Factory, file the task the person approved in step 3, label
it, \`kortix triggers fire factory-intake --wait 300s\`, and wait for the pull
request. Show it to the person: the summary, the commands with their real
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

A report of at most 15 lines: the loops now running and what starts each,
where tickets land, who merges, how to start work by hand (label an issue,
\`kortix triggers fire <slug>\`), how to add the next loop (ask this agent: it
edits \`kortix.yaml\` and ships it), what you wired on this computer (the MCP
server, the skills), where to watch (the workspace link), the answers you
took by default, the ideas kept for later, and anything still open.
`;
}

/** The production guide. */
export const SETUP_GUIDE = setupGuide();
