/**
 * The prompt a person copies into their own coding agent (Claude Code, Codex,
 * Cursor) to set up a repository they linked to Kortix that has no agents.
 *
 * Kortix never writes to a linked repository. The person's agent writes
 * `kortix.yaml` in their clone, validates it and pushes it; the project then
 * reads it from the branch. The prompt names the repository and the branch so
 * the push lands where the project reads.
 *
 * English on purpose: an agent reads it, not the person. The same steps are
 * in the docs (`developers.mdx`, "Set up an existing repository"); keep them in
 * step.
 */

export const EXISTING_REPO_DOCS_URL = 'https://kortix.com/docs/developers#set-up-an-existing-repository';

export function existingRepoSetupPrompt(input: {
  /** `owner/name`, or the clone URL when the name is unknown. */
  repository: string | null | undefined;
  /** The branch the project reads `kortix.yaml` from. */
  branch: string | null | undefined;
}): string {
  const repository = input.repository?.trim() || 'this repository';
  const branch = input.branch?.trim() || 'the default branch';
  return `Set up ${repository} for Kortix. Kortix reads \`kortix.yaml\` from the \`${branch}\` branch. The reference is ${EXISTING_REPO_DOCS_URL}.

1. If the \`kortix\` command is missing, install it: \`curl -fsSL https://kortix.com/install | bash\`.
2. Create \`kortix.yaml\` at the repository root with this content:

\`\`\`yaml
# yaml-language-server: $schema=https://kortix.com/schema/kortix.schema.json
project:
  name: "<the repository name>"
builtin_agents:
  my_kortix: true
default_agent: mykortix
skills: {}
agents:
  worker:
    description: "General-purpose worker: coding, research, writing, ops and data work."
    mode: primary
    permission: allow
    prompt: "You work in this repository. Read AGENTS.md or CLAUDE.md first when it exists."
    tools: "*"
    skills: "*"
    connectors: "*"
    secrets: "*"
    kortix_permissions: "*"
    workspace: { project_repository: true }
\`\`\`

3. Keep the agent setup this repository already has. Do not move, copy or edit those files.
   - For each \`.claude/agents/<name>.md\`, add an agent \`<name>\` with \`prompt_file: .claude/agents/<name>.md\`, the \`description\` from its frontmatter, \`mode: primary\`, \`tools: "*"\` and \`workspace: { project_repository: true }\`.
   - For each folder that holds a \`SKILL.md\` (\`.agents/skills/<name>\`, \`.claude/skills/<name>\`, \`skills/<name>\`), add \`<name>: <folder>\` under \`skills:\`. Skip a name that starts with \`kortix-\`.
4. Run \`kortix validate\`. Fix every error it prints and run it again until it exits 0.
5. Commit only \`kortix.yaml\` with the message "chore: add kortix.yaml" and push it to \`${branch}\`.
6. Reply with the agents and skills you declared.`;
}

/** `owner/name` from a GitHub clone URL, else the URL without `.git`. */
export function repositoryLabel(repoUrl: string | null | undefined): string | null {
  if (!repoUrl) return null;
  const match = /github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(repoUrl.trim());
  return match?.[1] ?? repoUrl.trim().replace(/\.git$/, '');
}
