import { encodeCompiledAgentConfigEnv } from '@kortix/api-contract/compiled-agent-config-env';
import { agentConfigEtag, type SessionWorkspaceSetup } from './compile-agent-config';

export interface SessionRuntimeEnvInput {
  projectId: string;
  sessionId: string;
  /** The project's Git proxy URL: where `kortix workspaces clone` and `git clone` fetch from. Never carries a credential. */
  repoUrl: string;
  baseRef: string;
  agentName: string;
  apiUrl: string;
  /** The API's release (`KORTIX_VERSION`) and build commit; sent as `KORTIX_RELEASE_VERSION` / `KORTIX_RELEASE_COMMIT`. */
  release?: { version: string; commit: string };
  /** Frontend base URL (no /v1) the sandbox surfaces as user-facing links. */
  frontendUrl?: string;
  sessionModel?: string | null;
  /** Server-compiled agent config (JSON string) — see `compile-agent-config.ts`.
   *  `null`/omitted for a project with no manifest file: no key is emitted. */
  compiledAgentConfig?: string | null;
  /** The session agent's kortix.yaml `codemode`; sent as `KORTIX_PI_CODEMODE` to a pi session only. Null: the daemon default (`on`). */
  piCodemode?: 'off' | 'on' | 'only' | null;
  /** The session agent's kortix.yaml `context`; sent as `KORTIX_PI_CONTEXT` to a pi session only when it is `summary`. Null: the daemon default (`record`). */
  piContext?: 'record' | 'summary' | null;
  /** The pi packages of the extensions the session agent enables; sent as `KORTIX_PI_PACKAGES` to a pi session only. */
  piPackages?: unknown[];
  /** The session agent's `workspace: { repos, setup }` (`manifestWorkspaceSetup`); null declares nothing. */
  workspaceSetup?: SessionWorkspaceSetup | null;
  /** The session row's `repository_access`: `repos` reach the box only with it. */
  repositoryAccess?: boolean;
  /** The prebuilt bundle of those packages (apps/api/src/pi-packages/bundle.ts); null when not built. */
  piPackagesBundle?: { digest: string; url: string; fallbackUrl: string } | null;
}

/**
 * The sandbox audit relay's emission contract
 * (apps/kortix-sandbox-agent-server/src/harness/shared/audit-relay.ts) is read from
 * the SANDBOX environment. A self-host operator can set these in compose; a
 * hosted sandbox has no such file, so the API forwards its own values when an
 * operator sets them. Only these four names cross, and only when non-empty —
 * an unset knob leaves the sandbox env byte-for-byte unchanged.
 *
 * This is the lever that retunes audit POST volume during an incident without
 * a daemon release.
 */
const AUDIT_RELAY_ENV_KEYS = [
  'KORTIX_AUDIT_RELAY_BATCH_SIZE',
  'KORTIX_AUDIT_RELAY_FLUSH_MS',
  'KORTIX_AUDIT_RELAY_DROP_TYPES',
  'KORTIX_AUDIT_RELAY_COALESCE',
] as const;

export function auditRelayEnvPassthrough(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const forwarded: Record<string, string> = {};
  for (const key of AUDIT_RELAY_ENV_KEYS) {
    const value = env[key];
    // `KORTIX_AUDIT_RELAY_DROP_TYPES=''` is a MEANINGFUL value (drop nothing),
    // so only an absent variable is skipped.
    if (typeof value === 'string') forwarded[key] = value;
  }
  return forwarded;
}

/**
 * `KORTIX_WORKSPACE_SETUP`: what kortixd prepares in the background after the session
 * starts (apps/kortix-sandbox-agent-server/src/harness/shared/workspace-setup.ts). Base64
 * JSON, version 1. A session without repository access gets no clone; the box says why.
 */
function workspaceSetupEnv(input: SessionRuntimeEnvInput): Record<string, string> {
  const spec = input.workspaceSetup;
  if (!spec) return {};
  const access = input.repositoryAccess ?? true;
  const body = {
    version: 1,
    repos: access ? spec.repos : [],
    ...(!access && spec.repos.length ? { repos_skipped: 'the agent has no project.gitops.read, or the person who started the session cannot read the files' } : {}),
    setup: spec.setup,
  };
  return { KORTIX_WORKSPACE_SETUP: Buffer.from(JSON.stringify(body), 'utf8').toString('base64') };
}

export function buildSessionRuntimeEnv(input: SessionRuntimeEnvInput): Record<string, string> {
  // A session never checks out the project repository at boot: /workspace
  // starts empty. The box still learns where the repository is and which branch
  // it may push (the Git proxy's ref policy allows the session branch only), so
  // `kortix workspaces clone` and `git clone "$KORTIX_REPO_URL"` work, and the
  // daemon's credential helper is configured for that URL.
  return {
    KORTIX_REPO_URL: input.repoUrl,
    KORTIX_DEFAULT_BRANCH: input.baseRef,
    KORTIX_BASE_REF: input.baseRef,
    KORTIX_BRANCH_NAME: input.sessionId,
    ...auditRelayEnvPassthrough(),
    // The workspace id is the project id. The box gets KORTIX_PROJECT_ID only:
    // the CLI and kortixd read KORTIX_WORKSPACE_ID first, so an injected
    // KORTIX_WORKSPACE_ID would outrank a script's own KORTIX_PROJECT_ID=<other>.
    // KORTIX_WORKSPACE_ID is the name a person or a script sets.
    KORTIX_PROJECT_ID: input.projectId,
    KORTIX_SESSION_ID: input.sessionId,
    KORTIX_SERVICE_PORT: '8000',
    KORTIX_AGENT_NAME: input.agentName,
    KORTIX_API_URL: input.apiUrl,
    // The sandbox CLI is the staging build's binary on prod too (images are
    // retagged, not rebuilt), so its baked version reads `X.Y.Z-staging.<sha8>`.
    // With these two values it reports the release this API serves instead
    // (apps/cli/src/cli-version.ts), and only when the commits match.
    ...(input.release?.version && input.release.commit
      ? { KORTIX_RELEASE_VERSION: input.release.version, KORTIX_RELEASE_COMMIT: input.release.commit }
      : {}),
    // A daemon released before 2026-11-08 clones when this reads '1'. Keep it
    // explicit until the runtime floor (session-open/runtime-floor-policy.ts)
    // excludes those daemons.
    KORTIX_PROJECT_AUTO_CLONE: '0',
    ...workspaceSetupEnv(input),
    // Which harness kortixd boots: always pi (OpenCode is deleted). Never leave it
    // out: an unset KORTIX_HARNESS marks a box OpenCode booted before the sunset,
    // and kortixd restores the session log into pi on it.
    KORTIX_HARNESS: 'pi',
    ...(input.piPackages?.length ? { KORTIX_PI_PACKAGES: JSON.stringify(input.piPackages) } : {}),
    ...(input.piCodemode ? { KORTIX_PI_CODEMODE: input.piCodemode } : {}),
    ...(input.piContext === 'summary' ? { KORTIX_PI_CONTEXT: 'summary' } : {}),
    ...(input.piPackagesBundle
      ? {
          KORTIX_PI_PACKAGES_BUNDLE_URL: input.piPackagesBundle.url,
          KORTIX_PI_PACKAGES_FALLBACK_URL: input.piPackagesBundle.fallbackUrl,
          KORTIX_PI_PACKAGES_BUNDLE_DIGEST: input.piPackagesBundle.digest,
        }
      : {}),
    // Frontend base for user-facing dashboard links — the agent/CLI must never
    // surface KORTIX_API_URL (the API host) to a human. See sandboxFrontendBaseUrl().
    ...(input.frontendUrl ? { KORTIX_FRONTEND_URL: input.frontendUrl } : {}),
    // The sandbox daemon creates the runtime's root session for every cold
    // session. The API adopts/persists that root; it must not create a competing one.
    KORTIX_BOOTSTRAP_RUNTIME_SESSION: '1',
    ...(input.sessionModel ? { KORTIX_MODEL: input.sessionModel } : {}),
    // The sandbox daemon applies this as the BASE of the agent config it runs
    // (connector / gateway provider / Slack overlays still apply on top). Per-call
    // The resolved session model (`KORTIX_MODEL` above), or an explicit
    // model on a prompt request, still wins over this compiled fallback.
    ...(input.compiledAgentConfig
      ? {
          // `KORTIX_COMPILED_AGENT_CONFIG=<json>` whenever it fits in one env
          // string, which is every config today's daemons read. Past 128 KiB the
          // guest cannot exec with it, so it travels gzipped in parts that each
          // fit (@kortix/api-contract/compiled-agent-config-env).
          ...encodeCompiledAgentConfigEnv(input.compiledAgentConfig),
          // Content hash of the line above, echoed by the daemon's /kortix/health.
          // It is what makes "is this session running the latest config?" a
          // question anyone can answer — the box reports what it actually
          // spawned with, rather than the API guessing from what it last sent.
          KORTIX_COMPILED_AGENT_CONFIG_ETAG: agentConfigEtag(input.compiledAgentConfig) ?? '',
        }
      : {}),
  };
}
