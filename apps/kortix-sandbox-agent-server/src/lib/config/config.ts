import { z } from 'zod'
import { workspaceIdFromEnv } from './workspace-id'

/**
 * Env contract for kortix-sandbox-agent-server.
 *
 * Names must stay aligned with apps/api/src/projects/index.ts: the API
 * passes KORTIX_REPO_URL / KORTIX_BRANCH_NAME /
 * KORTIX_DEFAULT_BRANCH / KORTIX_PROJECT_ID / KORTIX_API_URL /
 * KORTIX_SERVICE_PORT to Daytona at sandbox creation time. The provider layer
 * injects one session-scoped KORTIX_TOKEN. It authenticates daemon, CLI,
 * connector, Git-proxy and LLM-gateway requests. Each API route applies its own
 * narrower authorization. Upstream credentials remain server-side.
 */

const Schema = z.object({
  KORTIX_SERVICE_PORT: z.coerce.number().int().positive().default(8000),
  // Static web server port. Default 3211 is a hard contract: apps/web
  // (platform-client STATIC_FILE_SERVER, url.ts) and the starter `show` tool
  // build preview URLs against this exact port via /proxy/3211 and p3211-* .
  KORTIX_STATIC_PORT: z.coerce.number().int().positive().default(3211),
  KORTIX_WORKSPACE: z.string().default('/workspace'),
  // The session's working folder. The box never checks out the project
  // repository into it: an agent that needs the files runs `kortix workspaces clone`.
  KORTIX_PROJECT_TARGET: z.string().default('/workspace'),
  KORTIX_DEFAULT_BRANCH: z.string().default('main'),
  KORTIX_PROJECT_ID: z.string().optional(),
  KORTIX_API_URL: z.string().optional(),
  KORTIX_REPO_URL: z.string().optional(),
  KORTIX_BRANCH_NAME: z.string().optional(),
  // `1`: /workspace is a Platinum volume the API mounted, the only copy of the
  // session's files.
  KORTIX_WORKSPACE_VOLUME: z.string().optional(),
  KORTIX_BASE_SHA: z.string().optional(),
  // A presigned project-snapshot download descriptor (base64 JSON) from an API
  // released before 2026-11-08. Current APIs never send it. Optional: absent or expired → the daemon
  // fetches one from the Git proxy with KORTIX_TOKEN.
  KORTIX_PROJECT_SNAPSHOT_DESCRIPTOR: z.string().optional(),
  // The published config release (base64 JSON: release ID and signed store
  // URLs), signed by the API at session create. Absent or expired → the
  // daemon asks the config-release route.
  KORTIX_CONFIG_RELEASE: z.string().optional(),
  KORTIX_TOKEN: z.string().optional(),
  KORTIX_GIT_USER_NAME: z.string().default('Xera'),
  KORTIX_GIT_USER_EMAIL: z.string().default('xera@dosco.live'),
  // ── Harness selection ────────────────────────────────────────────────────
  // apps/api sets `pi` on every box (session-runtime-env.ts). A box OpenCode
  // booted before the sunset says `opencode` or nothing and boots pi too
  // (resolveHarness). Anything else fails boot loudly — a typo must never
  // silently boot something.
  KORTIX_HARNESS: z.string().default(''),
})

/** Host configuration. Native adapters own and validate their additional fields. */
export type Config = {
  /**
   * The selected harness id: `KORTIX_HARNESS`, lower-cased. Empty selects the
   * default, which only `resolveHarness` knows; `loadConfig` stores the id it resolved.
   */
  harness?: string
  servicePort: number
  staticPort: number
  workspace: string
  projectTarget: string
  defaultBranch: string
  projectId: string | undefined
  apiUrl: string | undefined
  repoUrl: string | undefined
  branchName: string | undefined
  /** /workspace is a volume (KORTIX_WORKSPACE_VOLUME=1): never cleared. */
  workspaceVolume?: boolean
  baseSha: string | undefined
  /** Presigned download descriptor for that pin (base64 JSON), when the API signed one at create. */
  projectSnapshotDescriptor?: string
  /** The published config release (base64 JSON), when the API signed one at create. */
  configRelease?: string
  /** The sandbox credential (HMAC key + sandbox-identity route bearer). NOT the
   *  session/user token — see the module doc. */
  sandboxToken: string | undefined
  gitUserName: string
  gitUserEmail: string
}

/**
 * The host's fields only. The daemon configuration is `loadConfig` in
 * harness/harness.ts: these fields plus the selected adapter's own.
 */
export function loadHostConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Schema.parse({
    KORTIX_SERVICE_PORT: env.KORTIX_SERVICE_PORT,
    KORTIX_STATIC_PORT: env.KORTIX_STATIC_PORT,
    KORTIX_WORKSPACE: env.KORTIX_WORKSPACE,
    KORTIX_PROJECT_TARGET: env.KORTIX_PROJECT_TARGET,
    KORTIX_DEFAULT_BRANCH: env.KORTIX_DEFAULT_BRANCH,
    // KORTIX_WORKSPACE_ID first, then the older KORTIX_PROJECT_ID (same value).
    KORTIX_PROJECT_ID: workspaceIdFromEnv(env) || undefined,
    KORTIX_API_URL: env.KORTIX_API_URL,
    KORTIX_REPO_URL: env.KORTIX_REPO_URL,
    KORTIX_BRANCH_NAME: env.KORTIX_BRANCH_NAME,
    KORTIX_WORKSPACE_VOLUME: env.KORTIX_WORKSPACE_VOLUME,
    KORTIX_BASE_SHA: env.KORTIX_BASE_SHA,
    KORTIX_PROJECT_SNAPSHOT_DESCRIPTOR: env.KORTIX_PROJECT_SNAPSHOT_DESCRIPTOR,
    KORTIX_CONFIG_RELEASE: env.KORTIX_CONFIG_RELEASE,
    KORTIX_TOKEN: env.KORTIX_TOKEN,
    KORTIX_GIT_USER_NAME: env.KORTIX_GIT_USER_NAME,
    KORTIX_GIT_USER_EMAIL: env.KORTIX_GIT_USER_EMAIL,
    KORTIX_HARNESS: env.KORTIX_HARNESS,
  })

  const harness = parsed.KORTIX_HARNESS.trim().toLowerCase()
  return {
    harness,
    servicePort: parsed.KORTIX_SERVICE_PORT,
    staticPort: parsed.KORTIX_STATIC_PORT,
    workspace: parsed.KORTIX_WORKSPACE,
    projectTarget: parsed.KORTIX_PROJECT_TARGET,
    defaultBranch: parsed.KORTIX_DEFAULT_BRANCH,
    projectId: parsed.KORTIX_PROJECT_ID,
    apiUrl: parsed.KORTIX_API_URL,
    repoUrl: parsed.KORTIX_REPO_URL,
    branchName: parsed.KORTIX_BRANCH_NAME,
    workspaceVolume: parsed.KORTIX_WORKSPACE_VOLUME === '1',
    baseSha: parsed.KORTIX_BASE_SHA,
    projectSnapshotDescriptor: parsed.KORTIX_PROJECT_SNAPSHOT_DESCRIPTOR?.trim() || undefined,
    configRelease: parsed.KORTIX_CONFIG_RELEASE?.trim() || undefined,
    sandboxToken: parsed.KORTIX_TOKEN,
    gitUserName: parsed.KORTIX_GIT_USER_NAME,
    gitUserEmail: parsed.KORTIX_GIT_USER_EMAIL,
  }
}

/**
 * Read `sandbox.on_boot` from the project manifest (`kortix.yaml`, else
 * `kortix.yml`): a shell command the daemon runs (backgrounded) once the repo
 * is materialized and the proxy is up, so a session can auto-start its dev
 * stack (e.g. `on_boot: "pnpm dev"`). Null when unset, empty, or the file does
 * not parse.
 */
/** `root`: the folder that holds kortix.yaml — the running config release's root at boot (the box has no checkout of the project). */
export async function resolveSandboxOnBoot(cfg: Config, root: string = cfg.projectTarget): Promise<string | null> {
  const { readFile } = await import('node:fs/promises')
  for (const file of ['kortix.yaml', 'kortix.yml']) {
    let body: string
    try {
      body = await readFile(`${root}/${file}`, 'utf8')
    } catch {
      continue
    }
    let parsed: unknown
    try {
      parsed = Bun.YAML.parse(body)
    } catch {
      return null
    }
    const value = (parsed as { sandbox?: { on_boot?: unknown } } | null)?.sandbox?.on_boot
    return typeof value === 'string' && value.trim() ? value.trim() : null
  }
  return null
}
