// The version this CLI reports.
//
// CI bakes KORTIX_CLI_VERSION into the binary. A release candidate is built
// once, on staging, and promoted by retagging, so the CLI inside a prod API
// image reads `X.Y.Z-staging.<sha8>+<sha8>` (apps/api/Dockerfile). A session
// receives the release its API serves (KORTIX_RELEASE_VERSION, the clean
// `X.Y.Z` on prod) and that API's build commit (KORTIX_RELEASE_COMMIT). When
// the commit the binary was built from matches it, the binary is that release,
// and the CLI says so.

const RELEASE = /^\d+\.\d+\.\d+$/;

/** The short commit a baked version names: `+<sha>` first, then `-<channel>.<sha>`. */
function bakedCommit(baked: string): string | null {
  const build = baked.match(/\+([0-9a-f]{7,40})$/i);
  if (build) return build[1]!.toLowerCase();
  const channel = baked.match(/-[a-z]+\.([0-9a-f]{7,40})$/i);
  return channel ? channel[1]!.toLowerCase() : null;
}

export function resolveCliVersion(
  baked: string,
  env: Record<string, string | undefined>,
): string {
  const release = env.KORTIX_RELEASE_VERSION?.trim();
  const commit = env.KORTIX_RELEASE_COMMIT?.trim().toLowerCase();
  if (!release || !commit || !RELEASE.test(release)) return baked;
  const sha = bakedCommit(baked);
  if (!sha || !commit.startsWith(sha)) return baked;
  return `${release}+${sha.slice(0, 8)}`;
}
