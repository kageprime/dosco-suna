import { setupPrompt, setupTarget } from '@kortix/shared/setup-guide';

/**
 * The prompt a person copies into their own coding agent (Claude Code, Codex,
 * Cursor) to set up a repository they linked to Kortix that has no agents.
 *
 * Kortix never writes to a linked repository. The person's agent follows the
 * served setup guide (`@kortix/shared/setup-guide`, https://kortix.com/setup.md)
 * and pushes `kortix.yaml` to the branch the workspace reads.
 */

export const EXISTING_REPO_DOCS_URL = 'https://kortix.com/docs/developers#set-up-an-existing-repository';

export function existingRepoSetupPrompt(input: {
  /** `owner/name`, or the clone URL when the name is unknown. */
  repository: string | null | undefined;
  /** The branch the project reads `kortix.yaml` from. */
  branch: string | null | undefined;
  /** The project's page in the web app (`dashboard_url`): its origin serves the guide this prompt names. */
  dashboardUrl?: string | null;
}): string {
  return setupPrompt({ repository: input.repository, branch: input.branch }, setupTarget(webOrigin(input.dashboardUrl)));
}

/** The origin of a web-app URL; undefined when absent or not a URL (the prompt then names production). */
function webOrigin(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

/** `owner/name` from a GitHub clone URL, else the URL without `.git`. */
export function repositoryLabel(repoUrl: string | null | undefined): string | null {
  if (!repoUrl) return null;
  const match = /github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(repoUrl.trim());
  return match?.[1] ?? repoUrl.trim().replace(/\.git$/, '');
}
