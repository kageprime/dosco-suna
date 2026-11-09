/** The config + file half of `GET /:projectId/detail`, split out of the route
 *  callback (KRTX-4441, behavior preserved): the snapshot-vs-live load, the
 *  per-resource scoping, the My Kortix/feature-flag assembly and the file
 *  visibility + per-capability gating. The route applies the returned
 *  `headers` (`X-Kortix-Config-Source`, `X-Kortix-Repo-Status`) and answers.
 */
import type { Context } from 'hono';
import { PROJECT_ACTIONS } from '../../iam';
import { listRepoFiles, loadProjectConfig } from '../git';
import { savedProjectConfig } from '../config-summary/service';
import { disconnectedProjectConfig } from '../git/config';
import { isRepositoryDisconnectedError } from '../../shared/repository-health';
import { withProjectGitAuth } from './git';
import { type loadProjectForUser, projectCapabilityAllowed } from './access';
import { applyDetailCapabilityFilter } from './detail-capability-filter';
import { MANIFEST_SYNTAX_ISSUE_PATH } from '@kortix/manifest-schema';
import { addMyKortixAgent, projectBuiltinAgents } from './my-kortix-agent';
import { featureFlagsEnvValue } from './feature-flag-env';
import { managedSkillFeatureFlag } from '../../skills/catalog';
import { denierFromConfig, filterConfigResourcesForUser } from './project-resources';
import type { AppEnv } from '../../types';
import { errorMessage } from '../../shared/error-message';

/**
 * The detail response's `config`, `files`/`file_count` and the status headers.
 * `headers` is returned, not set: the route writes them onto the response.
 */
export async function loadProjectDetailConfig(
  c: Context<AppEnv>,
  loaded: NonNullable<Awaited<ReturnType<typeof loadProjectForUser>>>,
  ref: string,
) {
  const projectId = loaded.row.projectId;
  const headers: Record<string, string> = {};
  // The saved summary of the default branch: no git on this path
  // (`config-summary/service.ts`). A moved tip rebuilds it behind the response.
  const saved = await savedProjectConfig(loaded.row);
  let files: Awaited<ReturnType<typeof listRepoFiles>> = [];
  let rawConfig: Awaited<ReturnType<typeof loadProjectConfig>>;
  const listLive = async (gitProject: Awaited<ReturnType<typeof withProjectGitAuth>>) => {
    try {
      return await listRepoFiles(gitProject, ref);
    } catch (error) {
      console.warn('[projects] repo detail listing unavailable', {
        projectId,
        error: errorMessage(error),
      });
      headers['X-Kortix-Repo-Status'] = 'unavailable';
      return [];
    }
  };
  if (saved) {
    headers['X-Kortix-Config-Source'] = `snapshot; commit=${saved.sourceCommit}`;
    rawConfig = saved.config;
    // Past the stored path cap the list comes from git, as before.
    if (saved.filesComplete) files = saved.files;
    else {
      const gitProject = await withProjectGitAuth(loaded.row).catch((error) => {
        if (isRepositoryDisconnectedError(error)) return null;
        throw error;
      });
      if (gitProject) files = await listLive(gitProject);
      else headers['X-Kortix-Repo-Status'] = 'disconnected';
    }
  } else {
    headers['X-Kortix-Config-Source'] = 'live';
    // A disconnected repository still renders the project shell: no files,
    // and a config whose `manifest_version.unknown_reason` names the cause.
    // `git_connection` below carries the reason and the fix.
    const gitProject = await withProjectGitAuth(loaded.row).catch((error) => {
      if (isRepositoryDisconnectedError(error)) return null;
      throw error;
    });
    if (!gitProject) {
      headers['X-Kortix-Repo-Status'] = 'disconnected';
    } else {
      files = await listLive(gitProject);
    }
    rawConfig = gitProject ? await loadProjectConfig(gitProject, files) : disconnectedProjectConfig();
  }
  // Per-resource scoping: hide agents/skills this member isn't granted (owner/
  // admins/SAs see everything). No-op when the project has no resource grants.
  const denierCtx = {
    userId: loaded.userId,
    accountId: loaded.row.accountId,
    projectId,
    actingTokenId: (c.get('iamTokenId') as string | undefined) ?? undefined,
  };
  const filteredConfig = await filterConfigResourcesForUser(rawConfig, denierCtx);
  // My Kortix (slug `mykortix`) is listed first when kortix.yaml sets
  // `builtin_agents.my_kortix: true`. Off: the config is exactly the
  // repo-declared surface. A kortix.yaml that is not YAML runs the last
  // version that parses (`rawConfig.manifest`); with none it is repair
  // mode, where My Kortix runs so it can be fixed (`loadProjectAgents`).
  const repairMode =
    rawConfig.manifest_health.issues.some((issue) => issue.path === MANIFEST_SYNTAX_ISSUE_PATH) &&
    Object.keys(rawConfig.manifest).length === 0;
  const builtinAgents = repairMode ? { my_kortix: true } : projectBuiltinAgents(rawConfig.manifest);
  const withAgents = {
    ...(builtinAgents.my_kortix ? addMyKortixAgent(filteredConfig) : filteredConfig),
    builtin_agents: builtinAgents,
  };
  // A Kortix skill behind a feature flag is listed only while the flag is on: the box does
  // not have it either (feature-flag-env.ts → kortixd).
  const enabledFlags = new Set(featureFlagsEnvValue(loaded.row.metadata).split(','));
  const config = {
    ...withAgents,
    skills: withAgents.skills.filter((skill) => {
      const flag = managedSkillFeatureFlag(skill.name);
      return !flag || enabledFlags.has(flag);
    }),
  };
  // …and hide the raw FILES of those resources from the file list (visibility
  // isolation). Reuses the config already loaded — no extra git round-trip.
  const denier = await denierFromConfig(rawConfig, denierCtx);
  const visibleFiles = denier ? files.filter((f) => !denier.isDenied(f.path)) : files;
  // Per-CAPABILITY filtering (distinct from the per-resource grants above): the
  // /detail bundle serves several read surfaces behind ONE project.read floor, so
  // gate each section on its own leaf. A plain `member` keeps the config sections
  // it can read but NOT the file list (member lacks project.file.read), and a
  // custom role that unchecks e.g. project.skill.read gets an empty skills
  // section — all WITHOUT 403-ing the whole workspace load (which loadProjectForUser
  // deliberately gates only on project.read so the shell renders for every member).
  const [canFiles, canAgents, canSkills, canCommands] = await Promise.all([
    projectCapabilityAllowed(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_FILE_READ,
    ),
    projectCapabilityAllowed(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_AGENT_READ,
    ),
    projectCapabilityAllowed(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_SKILL_READ,
    ),
    projectCapabilityAllowed(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_COMMAND_READ,
    ),
  ]);
  const gated = applyDetailCapabilityFilter(config, visibleFiles, {
    canFiles,
    canAgents,
    canSkills,
    canCommands,
  });
  return { config: gated.config, files: gated.files, file_count: gated.file_count, headers };
}
