import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { HarnessDiagnosticsContext } from '../contract/diagnostics'
import { readRepoInfo } from '@/lib/git/git'
import { runtimeConvergenceReport } from '@/services/runtime-assets/runtime-assets'
import { runtimeTruthReport } from '@/services/runtime-assets/runtime-truth'
import { workspaceSetupStatus } from './workspace-setup'

/**
 * The `/kortix/health` fields the host owns. Every harness reports them with
 * the same meaning; `routes/kortix/health.ts` adds the harness block and
 * computes `runtimeReady` from the harness's own readiness. `repo`, `branch` and
 * `commit_sha` describe a checkout in `/workspace` when an agent cloned one;
 * the box never clones at boot, so none is required.
 */
export async function readHostHealth(context: HarnessDiagnosticsContext) {
  const { cfg, bootState } = context
  const repoInfo = await readRepoInfo(cfg.projectTarget).catch(() => null)
  return {
    uptime_s: Math.floor((Date.now() - context.bootTime) / 1000),
    // Static web server (preview/static files). The bound port when up, else
    // null — surfaces "preview won't load because static-web never bound".
    static_web_port: context.staticWebPort,
    repo: repoInfo?.remoteUrl ?? null,
    branch: repoInfo?.branch ?? null,
    commit_sha: repoInfo?.commit ?? null,
    // The content hash of the compiled agent config the runtime spawned
    // with. Not derivable from commit_sha: a warm-workspace refresh advances
    // the commit while deliberately skipping the restart, so a box can report
    // the newest commit and still be running config compiled days ago. Read
    // from the live process env, so it tracks a hot push as well as a boot.
    agent_config_etag: process.env.KORTIX_COMPILED_AGENT_CONFIG_ETAG || null,
    // What this box last converged its own runtime to. Auto-update without
    // reporting only moves the uncertainty — this makes "is the fleet
    // current?" a query instead of a hope, and it is the signal that tells us
    // a fleet-drain gate has actually cleared. `pinned: true` means an update
    // crash-looped and the supervisor latched it off: that box will not
    // self-heal and needs a human.
    runtime: await runtimeConvergenceReport(),
    // The runtime-convergence contract (PR #7785), Rule 1: the ONE actual-runtime
    // document (release, daemon, cli, managed skills), each with its
    // own convergence state. The API computes the desired document and diffs
    // the two; this is only the box's own answer. A pure read — never
    // triggers a reconcile attempt, so polling health cannot itself cause work.
    runtime_truth: await runtimeTruthReport(),
    // The agent's `workspace: { repos, setup }`, prepared in the background after start:
    // null when it declares none. Never part of readiness.
    workspace_setup: workspaceSetupStatus(),
    // In-container boot timeline (ms since process start): the daemon, the
    // config release the runtime boots from (`config-release-*`), and the
    // runtime.
    boot_timeline: bootState.timeline,
    // Visible auth posture so misconfiguration doesn't silently downgrade.
    auth: cfg.sandboxToken ? 'configured' : 'unconfigured',
  }
}
