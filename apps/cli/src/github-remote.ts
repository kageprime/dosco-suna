/** `owner/repo` from a GitHub remote URL (https, ssh or scp form). */
export function githubRepoFromRemote(url: string): string | null {
  const match = url.trim().match(/github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  return match ? `${match[1]}/${match[2]}` : null;
}
