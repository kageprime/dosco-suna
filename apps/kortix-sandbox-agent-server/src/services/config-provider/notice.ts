import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod'

/**
 * Telling the SESSION, in words, which config it runs.
 *
 * A config release is served from a read-only directory under
 * `/opt/kortix/config`. `/workspace` is the session's own folder: the box never
 * checks out the project repository at boot. Without being told, an agent
 * looks for `kortix.yaml` in `/workspace`, finds nothing or a stale clone, and
 * edits files that change nothing. The notice says where the config is and how
 * to change it (a clone, a commit on the session branch, a change request).
 * When kortix.yaml has issues, the notice lists them.
 *
 * CHANNEL: the agent's system prompt. pi appends this file to it, as it does
 * the `secret-capabilities.ts` file. Chosen over posting a message into the
 * session because it costs no model call and starts no turn: `POST
 * /session/:id/prompt_async`, the only other in-box channel, would begin a
 * real turn after every convergence.
 *
 * It is a STATEMENT OF STATE, not an event, so it stays true on every later
 * turn. It names the commit, which is the identity a human checks.
 *
 * The file is rewritten only when its content changes: a convergence that
 * applies a new release rewrites it, and one that changes nothing does not
 * touch it (`'unchanged'`). The flag-off revert clears it.
 */
export const CONFIG_RELEASE_NOTICE_PATH =
  process.env.KORTIX_CONFIG_RELEASE_NOTICE_PATH || '/tmp/kortix/config-release.md'

export interface ConfigReleaseNotice {
  /** The commit the running release was built from. */
  sourceCommit: string | null
  /**
   * The repo-relative paths the release is built from, e.g. `agents`, `skills`
   * and the harness config dir. The harness adapter names them; this service
   * knows no harness layout.
   */
  sourcePaths: readonly string[]
  /** The session id, for the reload command. */
  sessionId?: string | null
  /** The read-only directory the release is served from, when it is known. */
  releaseDir?: string | null
  /**
   * The API's own sentence about an agent re-point, rendered VERBATIM.
   *
   * The API decides whether a session's agent moved to the project's declared
   * default and writes the sentence that explains it. Paraphrasing it here
   * would make two surfaces disagree about an access decision, and a second
   * channel would tell the session twice. It rides the notice, which is
   * already in the system prompt and is already written only when its text
   * changes — so this is stated once per change, like the commit line beside
   * it.
   */
  agentRepoint?: string | null
  /** The compiled set's `manifest_issues` (`manifestIssuesOf`): kortix.yaml's problems at the release's commit. */
  manifestIssues?: readonly ManifestIssue[]
}

/** The API sends at most this many issues; the notice lists at most this many. */
const MAX_MANIFEST_ISSUES = 50

/** One kortix.yaml issue, as the compiled set's `manifest_issues` carries it (apps/api): errors first. */
const ManifestIssueSchema = z.object({
  path: z.string(),
  message: z.string(),
  severity: z.enum(['error', 'warning']),
  line: z.number().int().positive().optional(),
  column: z.number().int().positive().optional(),
})
export type ManifestIssue = z.infer<typeof ManifestIssueSchema>

/**
 * The `manifest_issues` of a parsed compiled set, or none. An entry of another
 * shape is skipped. An API from before the field sends none.
 */
export function manifestIssuesOf(set: unknown): ManifestIssue[] {
  const raw = (set as { manifest_issues?: unknown } | null | undefined)?.manifest_issues
  if (!Array.isArray(raw)) return []
  return raw.flatMap((entry) => {
    const issue = ManifestIssueSchema.safeParse(entry)
    return issue.success ? [issue.data] : []
  })
}

/** `kortix.yaml:<line>:<col> <severity> <path> <message>`, on one line. */
function issueLine(issue: ManifestIssue): string {
  const at = issue.line ? `kortix.yaml:${issue.line}${issue.column ? `:${issue.column}` : ''}` : 'kortix.yaml'
  return [at, issue.severity, issue.path, issue.message.replace(/\s+/g, ' ').trim()].filter(Boolean).join(' ')
}

function renderManifestIssues(issues: readonly ManifestIssue[]): string[] {
  if (issues.length === 0) return []
  const errors = issues.filter((issue) => issue.severity === 'error').length
  const count = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
  const truncated = issues.length >= MAX_MANIFEST_ISSUES
  return [
    '',
    '## kortix.yaml has issues',
    '',
    `kortix.yaml on the base branch has ${truncated ? 'at least ' : ''}${count(errors, 'error')} and ${count(issues.length - errors, 'warning')}:`,
    '',
    ...issues.slice(0, MAX_MANIFEST_ISSUES).map((issue) => `- ${issueLine(issue)}`),
    '',
    ...(errors > 0 ? ['An agent or trigger with an error is off until the error is fixed.'] : []),
    'To fix kortix.yaml: run `kortix workspaces clone`, edit `kortix.yaml` in the clone, run `kortix validate`',
    'until it reports no error, then commit, `git push`, and `kortix cr open` against the base branch.',
  ]
}

/** Commits are named by their first 12 characters, as every Kortix surface does. */
function short(sha: string): string {
  return sha.slice(0, 12)
}

export function renderConfigReleaseNotice(notice: ConfigReleaseNotice): string {
  const commit = notice.sourceCommit ? short(notice.sourceCommit) : null
  // Repository paths: the box holds no checkout at boot, so a `/workspace/…` path would name nothing.
  const paths = notice.sourcePaths.map((path) => `\`${path}\``)
  const sourceFiles = notice.sourcePaths.length > 1 ? ['`kortix.yaml`', ...paths] : paths
  const editedPaths =
    paths.length > 1 ? `${paths.slice(0, -1).join(', ')} or ${paths.at(-1)}` : (paths[0] ?? 'the repository')
  const reload = notice.sessionId ? `kortix sessions reload ${notice.sessionId}` : 'kortix sessions reload <session id>'
  const at = commit ? ` at commit ${commit}` : ''
  const servedFrom = notice.releaseDir ?? '/opt/kortix/config/<release>'
  const repoint = notice.agentRepoint?.trim()
  return [
    "# This session's agent config",
    '',
    `This session runs the project's agent config from the base branch${at}. The`,
    `platform serves it read-only from \`${servedFrom}\`.`,
    '',
    "- `/workspace` is this session's own folder. It holds no copy of the project",
    '  repository unless you cloned one there.',
    `- The config is ${sourceFiles.join(', ')} in the project repository. Editing a copy of`,
    `  ${editedPaths} does NOT change the config this session runs. A change takes effect`,
    '  after it lands on the base branch.',
    '- To change this agent: run `kortix workspaces clone` (it checks out your session branch),',
    '  edit those files in the clone, commit, `git push`, then `kortix cr open` against the base branch.',
    '  Review the Git diff of those source files. Do not edit or commit the compiled',
    '  runtime config: it is generated and has no reverse mapping to kortix.yaml.',
    '  Agent settings also change without a clone: `kortix agents config <name> --set <key>=<value>`.',
    `- Writing into \`${servedFrom}\` fails with a permission error, on purpose.`,
    "  That copy is the platform's; edit the project's files in a clone.",
    `- \`${reload}\` moves this session onto the base branch's current config,`,
    '  in one command.',
    ...(repoint ? ['', '## This session\'s agent', '', repoint] : []),
    ...renderManifestIssues(notice.manifestIssues ?? []),
    '',
  ].join('\n')
}

/**
 * Write the notice, unless the file already says exactly this.
 *
 * `'unchanged'` is the answer for a convergence that changed nothing: the
 * agent must not be told its config just moved when it did not.
 */
export function writeConfigReleaseNotice(
  notice: ConfigReleaseNotice,
  path = CONFIG_RELEASE_NOTICE_PATH,
): 'written' | 'unchanged' {
  const body = renderConfigReleaseNotice(notice)
  try {
    if (readFileSync(path, 'utf8') === body) return 'unchanged'
  } catch {
    // Absent or unreadable: write it.
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, body, { encoding: 'utf8', mode: 0o600 })
  renameSync(tmp, path)
  return 'written'
}

/** No release runs any more: config releases are off for this project. */
export function clearConfigReleaseNotice(path = CONFIG_RELEASE_NOTICE_PATH): void {
  rmSync(path, { force: true })
}
