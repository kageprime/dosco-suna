/**
 * The Harbor task format (https://harborframework.com/docs/tasks), read as is:
 *
 *   <task>/task.toml          timeouts, resources, metadata
 *   <task>/instruction.md     the prompt the agent gets
 *   <task>/environment/       Dockerfile (or `[environment].docker_image`)
 *   <task>/tests/test.sh      the verifier; writes the reward
 *   <task>/solution/solve.sh  optional reference solution (the `oracle` agent runs it)
 *
 * Pure: it takes file contents and returns the parsed task. Reading the files
 * is `task-source.ts`.
 */
import { EVAL_LIMITS } from '@kortix/api-contract';
import ignore, { type Ignore } from 'ignore';

/** `[environment.healthcheck]`: Docker HEALTHCHECK semantics, run before the agent starts. */
export interface HarborHealthcheck {
  command: string;
  intervalSec: number;
  timeoutSec: number;
  startPeriodSec: number;
  startIntervalSec: number;
  retries: number;
}

/** One `artifacts` entry: a sandbox path collected after the agent phase. */
export interface HarborArtifact {
  source: string;
  /** Where it lands below the trial's `artifacts/`; null mirrors the source path. */
  destination: string | null;
  /** tar `--exclude` patterns, for a directory. */
  exclude: string[];
}

/**
 * Where a separate verifier runs, by Harbor's image precedence: the verifier's
 * own `docker_image`, else `tests/Dockerfile`, else the task's environment.
 */
export interface HarborVerifierEnvironment {
  source: 'verifier-image' | 'tests-dockerfile' | 'task-environment';
  dockerImage: string | null;
  /** `tests/Dockerfile` for `tests-dockerfile`, `environment/Dockerfile` for `task-environment`. */
  hasDockerfile: boolean;
  /** The text of that Dockerfile, when it was read. */
  dockerfile: string | null;
  cpus: number | null;
  memoryMb: number | null;
  storageMb: number | null;
  /** `[verifier.environment.env]`, or `[environment.env]` for a copy of the task's environment. */
  env: Record<string, string>;
  /** `[verifier.environment].workdir`; null reads the image's. */
  workdir: string | null;
  /** The image holds `/tests` (a verifier image or tests/Dockerfile): Harbor uploads no tests into it. */
  testsBaked: boolean;
}

export interface HarborTask {
  /** `[task].name`, else the folder name. */
  name: string;
  instruction: string;
  agentTimeoutSec: number;
  verifierTimeoutSec: number;
  buildTimeoutSec: number;
  /** `[environment].docker_image`. */
  dockerImage: string | null;
  /** True when the task ships `environment/Dockerfile`. */
  hasDockerfile: boolean;
  /** The text of `environment/Dockerfile`, when the task ships one. */
  dockerfile: string | null;
  /** `[environment].workdir`, else the last `WORKDIR` of the Dockerfile. */
  workdir: string | null;
  cpus: number | null;
  memoryMb: number | null;
  storageMb: number | null;
  /** `[verifier.env]`, `[solution.env]`, `[environment.env]`. */
  verifierEnv: Record<string, string>;
  solutionEnv: Record<string, string>;
  environmentEnv: Record<string, string>;
  agentUser: string | null;
  verifierUser: string | null;
  metadata: Record<string, unknown>;
  hasSolution: boolean;
  healthcheck: HarborHealthcheck | null;
  /** Task-level `artifacts`, without the implicit `/logs/artifacts` entry. */
  artifacts: HarborArtifact[];
  /** `shared`: the tests run in the agent's sandbox. `separate`: in a fresh one, see `verifierEnvironment`. */
  verifierMode: 'shared' | 'separate';
  /** Set when `verifierMode` is `separate`. */
  verifierEnvironment: HarborVerifierEnvironment | null;
  /** `[[steps]]` in order; empty for a single-step task. */
  steps: HarborStep[];
  /** `multi_step_reward_strategy`: the trial's reward is the per-key mean of its steps, or the last step's. */
  stepRewardStrategy: 'mean' | 'final';
  /** `[metadata.kortix]`: how Kortix runs the task. */
  kortix: KortixTaskOptions;
  /** Why Kortix cannot run this task, or null. */
  unsupported: string | null;
}

/**
 * One step of a multi-step task (`steps/<name>/`). Every step continues the
 * same session: a Kortix agent is a chat, so a later step is the person's next
 * message, never a new agent in the same sandbox.
 */
export interface HarborStep {
  name: string;
  instruction: string;
  /** `[steps.agent].timeout_sec`; null takes the task's. */
  agentTimeoutSec: number | null;
  verifierTimeoutSec: number | null;
  verifierEnv: Record<string, string>;
  /** Below it the remaining steps are skipped: a number gates the `reward` key, a table each key it names. */
  minReward: number | Record<string, number> | null;
  hasTests: boolean;
  hasSolution: boolean;
  /** `steps/<name>/workdir/setup.sh`: it runs before the step's instruction is sent. */
  hasSetup: boolean;
  hasWorkdir: boolean;
}

/** `[metadata.kortix]`, Kortix's own table in Harbor's free-form metadata. */
export interface KortixTaskOptions {
  /** `fresh`: every trial runs in a workspace of its own, made for it and deleted after it. */
  workspace: 'shared' | 'fresh';
  /** What a fresh workspace may spend, moved from the job's workspace and refunded after; null is the default. */
  budgetUsd: number | null;
  /** `[metadata].requires_flags`: a fresh workspace gets them turned on. */
  flags: string[];
}

export class HarborTaskError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HarborTaskError';
  }
}

const isTable = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const table = (value: unknown): Record<string, unknown> => (isTable(value) ? value : {});

function stringMap(value: unknown): Record<string, string> {
  return Object.fromEntries(
    Object.entries(table(value)).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}

const positive = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;

/** `memory_mb = 2048`, or the older `memory = "2G"` / `storage = "10G"` of Terminal-Bench 2.0. */
function megabytes(mb: unknown, legacy: unknown): number | null {
  const direct = positive(mb);
  if (direct) return Math.round(direct);
  if (typeof legacy !== 'string') return null;
  const match = /^\s*(\d+(?:\.\d+)?)\s*([kmgt])i?b?\s*$/i.exec(legacy);
  if (!match) return null;
  const factor = { k: 1 / 1024, m: 1, g: 1024, t: 1024 * 1024 }[match[2]!.toLowerCase() as 'k' | 'm' | 'g' | 't'];
  return Math.round(Number(match[1]) * factor);
}

/**
 * The instruction as the agent gets it. Harbor drops leading markdown comments,
 * which is where a benchmark keeps its canary string.
 */
export function cleanInstruction(raw: string): string {
  let text = raw.replace(/^﻿/, '');
  for (;;) {
    const next = text.replace(/^\s*<!--[\s\S]*?-->/, '');
    if (next === text) break;
    text = next;
  }
  return text.trim();
}

/** The last `WORKDIR` of a Dockerfile: where the image's commands run. */
export function dockerfileWorkdir(dockerfile: string): string | null {
  let workdir: string | null = null;
  for (const line of dockerfile.split('\n')) {
    const match = /^\s*WORKDIR\s+(\S.*?)\s*$/i.exec(line);
    if (!match) continue;
    const path = match[1]!.replace(/^["']|["']$/g, '');
    workdir = path.startsWith('/') ? path : `${(workdir ?? '').replace(/\/$/, '')}/${path}`;
  }
  return workdir;
}

const nonNegative = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;

function parseHealthcheck(value: unknown, where: string): HarborHealthcheck | null {
  if (value === undefined || value === null) return null;
  const hc = table(value);
  if (typeof hc.command !== 'string' || !hc.command.trim()) throw new HarborTaskError(`${where}: [environment.healthcheck] needs a command.`);
  return {
    command: hc.command,
    intervalSec: positive(hc.interval_sec) ?? 5,
    timeoutSec: positive(hc.timeout_sec) ?? 30,
    startPeriodSec: nonNegative(hc.start_period_sec, 0),
    startIntervalSec: positive(hc.start_interval_sec) ?? 5,
    retries: Math.max(1, Math.floor(nonNegative(hc.retries, 3))),
  };
}

/** Harbor's `ArtifactConfig` validation: no `..`, and a destination is a relative path that is not `manifest.json`. */
function parseArtifacts(value: unknown, where: string): { artifacts: HarborArtifact[]; sidecar: boolean } {
  if (value === undefined || value === null) return { artifacts: [], sidecar: false };
  if (!Array.isArray(value)) throw new HarborTaskError(`${where}: artifacts must be a list.`);
  let sidecar = false;
  const artifacts = value.map((entry): HarborArtifact => {
    const raw = typeof entry === 'string' ? { source: entry } : table(entry);
    const source = typeof raw.source === 'string' ? raw.source.trim() : '';
    if (!source) throw new HarborTaskError(`${where}: an artifacts entry has no source.`);
    if (source.split('/').includes('..')) throw new HarborTaskError(`${where}: artifact source ${source} must not contain '..'.`);
    let destination = typeof raw.destination === 'string' && raw.destination ? raw.destination : null;
    if (destination !== null) {
      const parts = destination.split('/').filter((part) => part && part !== '.');
      if (destination.includes('\\') || destination.startsWith('/') || parts.length === 0 || parts.includes('..') || destination.replace(/\/+$/, '') === 'manifest.json') {
        throw new HarborTaskError(`${where}: artifact destination ${destination} must be a relative path inside artifacts/, not manifest.json.`);
      }
      destination = parts.join('/');
    }
    if (typeof raw.service === 'string' && raw.service !== 'main') sidecar = true;
    const exclude = Array.isArray(raw.exclude) ? raw.exclude.filter((pattern): pattern is string => typeof pattern === 'string' && pattern !== '') : [];
    return { source, destination, exclude };
  });
  return { artifacts, sidecar };
}

/** The network policy of one table, when it restricts egress: `no-network`, `allowlist`, or the deprecated `allow_internet = false`. */
function restrictedNetwork(section: Record<string, unknown>): string | null {
  if (section.network_mode === 'no-network' || section.network_mode === 'allowlist') return section.network_mode;
  if (section.allow_internet === false) return 'no-network';
  return null;
}

/**
 * Harbor's verifier mode and image precedence (`verifier_mode.py`): an
 * explicit `environment_mode`, else `separate` when `[verifier.environment]`
 * exists, else `shared`. A separate verifier runs the first of: the verifier's
 * `docker_image` (tests baked), `tests/Dockerfile` (tests baked), the task's
 * own environment (tests uploaded). Resources come from `[verifier.environment]`
 * when it is set, else from `[environment]`.
 */
function resolveVerifier(
  verifier: Record<string, unknown>,
  environment: Record<string, unknown>,
  has: (path: string) => boolean,
  texts: { environment: string | null; tests: string | null },
): { mode: 'shared' | 'separate'; environment: HarborVerifierEnvironment | null; conflict: boolean } {
  const own = isTable(verifier.environment) ? verifier.environment : null;
  const explicit = verifier.environment_mode === 'shared' || verifier.environment_mode === 'separate' ? verifier.environment_mode : null;
  const mode = explicit ?? (own ? 'separate' : 'shared');
  if (mode === 'shared') return { mode, environment: null, conflict: own !== null };
  const config = own ?? environment;
  const image = typeof own?.docker_image === 'string' && own.docker_image.trim() ? own.docker_image.trim() : null;
  const taskImage = typeof environment.docker_image === 'string' && environment.docker_image.trim() ? environment.docker_image.trim() : null;
  const base = {
    cpus: positive(config.cpus),
    memoryMb: megabytes(config.memory_mb, config.memory),
    storageMb: megabytes(config.storage_mb, config.storage),
    env: stringMap(config.env),
    workdir: typeof config.workdir === 'string' && config.workdir.startsWith('/') ? config.workdir : null,
  };
  if (image) return { mode, conflict: false, environment: { ...base, source: 'verifier-image', dockerImage: image, hasDockerfile: false, dockerfile: null, testsBaked: true } };
  if (has('tests/Dockerfile')) return { mode, conflict: false, environment: { ...base, source: 'tests-dockerfile', dockerImage: null, hasDockerfile: true, dockerfile: texts.tests, testsBaked: true } };
  return {
    mode,
    conflict: false,
    environment: { ...base, source: 'task-environment', dockerImage: taskImage, hasDockerfile: has('environment/Dockerfile'), dockerfile: texts.environment, testsBaked: false },
  };
}

export interface HarborTaskFiles {
  /** The folder name of the task. */
  folderName: string;
  taskToml: string | null;
  instruction: string | null;
  dockerfile: string | null;
  /** `tests/Dockerfile`, read when the task ships one. */
  testsDockerfile?: string | null;
  /** Paths of the task folder, relative to it. */
  paths: readonly string[];
  /** `steps/<name>/instruction.md` of every step that has one. */
  stepInstructions?: Readonly<Record<string, string>>;
}

/** Harbor's portable step name: a directory name on every OS. */
const STEP_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function parseMinReward(value: unknown, where: string): number | Record<string, number> | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (isTable(value) && Object.values(value).every((v) => typeof v === 'number' && Number.isFinite(v))) return value as Record<string, number>;
  throw new HarborTaskError(`${where}: min_reward must be a number or a table of numbers.`);
}

/** `[[steps]]` with their folders. The unsupported reason comes back separately: a step Kortix cannot run yet is named, not run. */
function parseSteps(toml: Record<string, unknown>, files: HarborTaskFiles, has: (path: string) => boolean): { steps: HarborStep[]; unsupported: string | null } {
  if (!Array.isArray(toml.steps)) return { steps: [], unsupported: null };
  const seen = new Set<string>();
  let unsupported: string | null = null;
  const steps = toml.steps.map((entry): HarborStep => {
    const raw = table(entry);
    const name = typeof raw.name === 'string' ? raw.name : '';
    if (!STEP_NAME.test(name) || name === '.' || name === '..') throw new HarborTaskError(`${files.folderName}: step name ${JSON.stringify(name)} is not a portable directory name.`);
    const key = name.normalize('NFC').toLowerCase();
    if (seen.has(key)) throw new HarborTaskError(`${files.folderName}: step names must be unique: ${name}.`);
    seen.add(key);
    const dir = `steps/${name}`;
    const instruction = files.stepInstructions?.[name];
    if (instruction === undefined) throw new HarborTaskError(`${files.folderName}: no ${dir}/instruction.md.`);
    if (!has(`${dir}/tests/test.sh`)) throw new HarborTaskError(`${files.folderName}: no ${dir}/tests/test.sh.`);
    const agent = table(raw.agent);
    const verifier = table(raw.verifier);
    if (!unsupported && raw.healthcheck !== undefined) unsupported = `Step ${name} has its own healthcheck, which Kortix does not run yet.`;
    if (!unsupported && Array.isArray(raw.artifacts) && raw.artifacts.length > 0) unsupported = `Step ${name} collects its own artifacts, which Kortix does not run yet.`;
    if (!unsupported && (verifier.environment_mode === 'separate' || isTable(verifier.environment))) unsupported = `Step ${name} has a separate verifier, which Kortix does not run for steps yet.`;
    return {
      name,
      instruction: cleanInstruction(instruction),
      agentTimeoutSec: positive(agent.timeout_sec),
      verifierTimeoutSec: positive(verifier.timeout_sec),
      verifierEnv: stringMap(verifier.env),
      minReward: parseMinReward(raw.min_reward, `${files.folderName} step ${name}`),
      hasTests: true,
      hasSolution: has(`${dir}/solution/solve.sh`),
      hasSetup: has(`${dir}/workdir/setup.sh`),
      hasWorkdir: files.paths.some((path) => path.startsWith(`${dir}/workdir/`)),
    };
  });
  return { steps, unsupported };
}

function parseKortixOptions(metadata: Record<string, unknown>, where: string): KortixTaskOptions {
  const own = table(metadata.kortix);
  const workspace = own.workspace ?? 'shared';
  if (workspace !== 'shared' && workspace !== 'fresh') throw new HarborTaskError(`${where}: [metadata.kortix] workspace must be "shared" or "fresh".`);
  let budgetUsd: number | null = null;
  if (own.budget_usd !== undefined) {
    budgetUsd = positive(own.budget_usd);
    if (budgetUsd === null || budgetUsd > 100) throw new HarborTaskError(`${where}: [metadata.kortix] budget_usd must be more than 0 and at most 100.`);
  }
  const flags = Array.isArray(metadata.requires_flags) ? metadata.requires_flags.filter((flag): flag is string => typeof flag === 'string' && flag !== '') : [];
  return { workspace, budgetUsd, flags };
}

/** Parse one task folder. Throws `HarborTaskError` when it is not a runnable task. */
export function parseHarborTask(files: HarborTaskFiles): HarborTask {
  if (files.taskToml === null) throw new HarborTaskError(`${files.folderName}: no task.toml.`);
  let toml: Record<string, unknown>;
  try {
    toml = table(Bun.TOML.parse(files.taskToml));
  } catch (err) {
    throw new HarborTaskError(`${files.folderName}/task.toml is not valid TOML: ${err instanceof Error ? err.message : String(err)}`);
  }
  const has = (path: string) => files.paths.includes(path);
  const multiStep = Array.isArray(toml.steps);
  const environment = table(toml.environment);
  const verifier = table(toml.verifier);
  const agent = table(toml.agent);
  const resolved = resolveVerifier(verifier, environment, has, { environment: files.dockerfile, tests: files.testsDockerfile ?? null });
  if (!multiStep && files.instruction === null) throw new HarborTaskError(`${files.folderName}: no instruction.md.`);
  // A verifier image bakes its tests: the task folder need not carry them.
  if (!multiStep && !has('tests/test.sh') && resolved.environment?.source !== 'verifier-image') throw new HarborTaskError(`${files.folderName}: no tests/test.sh.`);

  const dockerImage = typeof environment.docker_image === 'string' && environment.docker_image.trim() ? environment.docker_image.trim() : null;
  const hasCompose = files.paths.some((path) => /^environment\/docker-compose\.ya?ml$/.test(path));
  const healthcheck = parseHealthcheck(environment.healthcheck, files.folderName);
  const { artifacts, sidecar } = parseArtifacts(toml.artifacts, files.folderName);
  const verifierEnvironment = isTable(verifier.environment) ? verifier.environment : {};
  const network = [
    ['[environment]', restrictedNetwork(environment)],
    ['[agent]', restrictedNetwork(agent)],
    ['[verifier]', restrictedNetwork(verifier)],
    ['[verifier.environment]', restrictedNetwork(verifierEnvironment)],
  ].find(([, mode]) => mode !== null);

  const parsedSteps = parseSteps(toml, files, has);
  const kortix = parseKortixOptions(table(toml.metadata), files.folderName);
  let unsupported: string | null = parsedSteps.unsupported;
  if (unsupported === null) unsupported = unsupportedReason();
  function unsupportedReason(): string | null {
    if (multiStep && resolved.mode === 'separate') return 'A multi-step task with a separate verifier does not run on Kortix yet.';
    if (kortix.workspace === 'fresh' && (dockerImage || has('environment/Dockerfile'))) {
      return "A task in a fresh workspace runs on the agent's own sandbox: it cannot also name a docker_image or an environment/Dockerfile.";
    }
    if (environment.os === 'windows') return 'Windows tasks do not run on Kortix.';
    if (hasCompose) return 'Multi-container tasks (`environment/docker-compose.yaml`) do not run on Kortix yet.';
    if (positive(environment.gpus) || environment.tpu || positive(verifierEnvironment.gpus)) return 'GPU and TPU tasks do not run on Kortix.';
    if (resolved.conflict) return '`environment_mode = "shared"` under `[verifier]` cannot be combined with `[verifier.environment]`.';
    if (resolved.environment?.source === 'tests-dockerfile' && files.paths.some((path) => /^tests\/docker-compose\.ya?ml$/.test(path))) {
      return 'A multi-container verifier (`tests/docker-compose.yaml`) does not run on Kortix yet.';
    }
    if (sidecar) return 'Artifacts from a Compose service other than `main` need a multi-container environment, which Kortix does not run yet.';
    if (Array.isArray(environment.mcp_servers) && environment.mcp_servers.length > 0) {
      return 'This task gives the agent MCP servers (`[[environment.mcp_servers]]`). Kortix sessions do not attach task MCP servers, so the agent would run without the tools the task expects.';
    }
    if (network) {
      return `This task restricts network access (${network[0]} network_mode = "${network[1]}"). Kortix does not enforce sandbox network policies yet, so the agent would run with full internet access and the score would not be comparable.`;
    }
    return null;
  }

  const taskName = typeof table(toml.task).name === 'string' ? String(table(toml.task).name).trim() : '';
  return {
    name: taskName || files.folderName,
    instruction: files.instruction !== null ? cleanInstruction(files.instruction) : (parsedSteps.steps[0]?.instruction ?? ''),
    agentTimeoutSec: positive(agent.timeout_sec) ?? EVAL_LIMITS.agent_timeout_sec_default,
    verifierTimeoutSec: positive(verifier.timeout_sec) ?? EVAL_LIMITS.verifier_timeout_sec_default,
    buildTimeoutSec: positive(environment.build_timeout_sec) ?? 600,
    dockerImage,
    hasDockerfile: has('environment/Dockerfile'),
    dockerfile: files.dockerfile,
    workdir:
      (typeof environment.workdir === 'string' && environment.workdir.startsWith('/') ? environment.workdir : null) ??
      (files.dockerfile ? dockerfileWorkdir(files.dockerfile) : null),
    cpus: positive(environment.cpus),
    memoryMb: megabytes(environment.memory_mb, environment.memory),
    storageMb: megabytes(environment.storage_mb, environment.storage),
    verifierEnv: stringMap(verifier.env),
    solutionEnv: stringMap(table(toml.solution).env),
    environmentEnv: stringMap(environment.env),
    agentUser: typeof agent.user === 'string' ? agent.user : null,
    verifierUser: typeof verifier.user === 'string' ? verifier.user : null,
    metadata: table(toml.metadata),
    hasSolution: has('solution/solve.sh'),
    healthcheck,
    artifacts,
    verifierMode: resolved.mode,
    verifierEnvironment: resolved.environment,
    steps: parsedSteps.steps,
    stepRewardStrategy: toml.multi_step_reward_strategy === 'final' ? 'final' : 'mean',
    kortix,
    unsupported,
  };
}

// ── Dockerfiles built without a context ──────────────────────────────────────

/** One logical line of a Dockerfile: kept as written, or a `COPY`/`ADD` of the task's own files. */
export type DockerfileStep =
  | { line: string }
  | { copy: { sources: string[]; dest: string; chown: string | null; chmod: string | null; instruction: string } };

const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;
const ARCHIVE = /\.(tar|tgz|tar\.gz|tar\.bz2|tbz2|tar\.xz|txz)$/i;

/**
 * Read a Dockerfile for a sandbox template, which builds without a build
 * context. `COPY --from=<stage or image>` and `ADD <url>` stay as written; a
 * `COPY`/`ADD` of the task's own files (`environment/` for
 * `environment/Dockerfile`, `tests/` for `tests/Dockerfile`) becomes a copy
 * step that `inlineDockerfile` writes into the image. In `tests/Dockerfile`
 * the `COPY . /tests` Harbor writes is dropped: the runner uploads `tests/`
 * there after the build. What cannot be copied without Docker's own build is
 * named as the reason: a local archive `ADD` (Docker unpacks it), a heredoc,
 * a variable in a path.
 */
export function dockerfileSteps(text: string, file: string): DockerfileStep[] | { reason: string } {
  const steps: DockerfileStep[] = [];
  for (const physical of text.replace(/\\\r?\n/g, '\u0000').split(/\r?\n/)) {
    const instruction = physical.replace(/\u0000/g, ' ').trim();
    const match = /^(COPY|ADD)\s+(.*)$/i.exec(instruction);
    const line = physical.replace(/\u0000/g, '\\\n');
    if (!match) {
      steps.push({ line });
      continue;
    }
    const why = (problem: string) => ({ reason: `This task's ${file} ${problem} (\`${instruction.slice(0, 80)}\`), which a Kortix sandbox template cannot build. Give the task a prebuilt \`docker_image\`.` });
    const rest = match[2]!.trim();
    if (rest.includes('<<')) return why('copies a heredoc');
    const words = rest.startsWith('[') ? (() => { try { return JSON.parse(rest) as unknown; } catch { return null; } })() : rest.split(/\s+/);
    if (!Array.isArray(words) || !words.every((word) => typeof word === 'string')) return why('has a COPY it cannot read');
    const flags = (words as string[]).filter((word) => word.startsWith('--'));
    const args = (words as string[]).filter((word) => !word.startsWith('--'));
    if (flags.some((flag) => /^--from=/i.test(flag))) {
      steps.push({ line });
      continue;
    }
    const sources = args.slice(0, -1);
    const dest = args[args.length - 1];
    if (!dest || sources.length === 0) return why('has a COPY without a source');
    const add = match[1]!.toUpperCase() === 'ADD';
    if (add && sources.every((src) => /^https?:\/\//i.test(src))) {
      steps.push({ line });
      continue;
    }
    if (add && sources.some((src) => /^https?:\/\//i.test(src) || ARCHIVE.test(src))) return why('adds an archive Docker would unpack');
    if ([...sources, dest].some((value) => value.includes('$'))) return why('names a path with a variable');
    if (file === 'tests/Dockerfile' && sources.length === 1 && /^\.\/?$/.test(sources[0]!) && /^\/tests\/?$/.test(dest)) continue;
    const flag = (name: string) => flags.find((value) => value.toLowerCase().startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;
    steps.push({ copy: { sources, dest, chown: flag('chown'), chmod: flag('chmod'), instruction } });
  }
  return steps;
}

export const dockerfileCopies = (steps: DockerfileStep[]): boolean => steps.some((step) => 'copy' in step);

/** The Dockerfile of steps that copy nothing. */
export const renderDockerfile = (steps: DockerfileStep[]): string => steps.map((step) => ('line' in step ? step.line : '')).join('\n');

/** Raw bytes a template's Dockerfile may carry, and the `RUN` steps that write them. */
export const INLINE_CONTEXT_LIMITS = { bytes: 1024 * 1024, runChars: 64 * 1024, runs: 60 };

/**
 * The Dockerfile with every copy step written out as `RUN` steps that create
 * the same files: `printf | base64 -d` per file, chunked under the 128 KiB
 * argument limit of `sh -c`. `context` holds the files of the build context
 * (`environment/` or `tests/`), by path relative to it. Docker's rules apply:
 * a directory source copies its contents into `dest`; several sources, a
 * glob or a `dest` ending in `/` make `dest` a directory; a relative `dest`
 * is relative to `WORKDIR`. A file starting with `#!` is made executable (the
 * task's file modes are not kept); `--chmod` and `--chown` apply after.
 */
export function inlineDockerfile(steps: DockerfileStep[], context: ReadonlyMap<string, Uint8Array>): { dockerfile: string } | { reason: string } {
  const out: string[] = [];
  let bytes = 0;
  let runs = 0;
  const files = [...context.keys()].sort();
  for (const step of steps) {
    if ('line' in step) {
      out.push(step.line);
      continue;
    }
    const { sources, dest, chown, chmod, instruction } = step.copy;
    const targets: Array<{ target: string; data: Uint8Array }> = [];
    let destIsDir = dest.endsWith('/') || sources.length > 1;
    const resolved: Array<{ kind: 'file' | 'dir'; src: string; matches: string[] }> = [];
    for (const raw of sources) {
      const src = raw.replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+$/, '');
      if (/[*?[]/.test(src)) {
        const glob = new Bun.Glob(src);
        const matches = files.filter((path) => glob.match(path));
        if (!matches.length) return { reason: `\`${instruction.slice(0, 80)}\` matches no file of the task.` };
        destIsDir = true;
        for (const path of matches) resolved.push({ kind: 'file', src: path, matches: [path] });
      } else if (src && src !== '.' && context.has(src)) {
        resolved.push({ kind: 'file', src, matches: [src] });
      } else {
        const prefix = !src || src === '.' ? '' : `${src}/`;
        const matches = files.filter((path) => path.startsWith(prefix));
        if (!matches.length) return { reason: `\`${instruction.slice(0, 80)}\` copies ${raw}, which the task does not have.` };
        destIsDir = true;
        resolved.push({ kind: 'dir', src: prefix, matches });
      }
    }
    const base = dest.replace(/\/+$/, '') || '/';
    const join = (dir: string, name: string) => (dir === '/' ? `/${name}` : `${dir}/${name}`);
    for (const entry of resolved) {
      for (const path of entry.matches) {
        const target = entry.kind === 'dir' ? join(base, path.slice(entry.src.length)) : destIsDir ? join(base, path.split('/').pop()!) : base;
        targets.push({ target, data: context.get(path)! });
      }
    }
    const commands: string[] = [];
    for (const { target, data } of targets) {
      bytes += data.byteLength;
      if (bytes > INLINE_CONTEXT_LIMITS.bytes) return { reason: `The files this task's Dockerfile copies are larger than ${INLINE_CONTEXT_LIMITS.bytes / 1024 / 1024} MB, which a Kortix sandbox template cannot carry. Give the task a prebuilt \`docker_image\`.` };
      const dir = target.includes('/') ? target.slice(0, target.lastIndexOf('/')) || '/' : '.';
      const encoded = Buffer.from(data).toString('base64');
      const after = [
        ...(data[0] === 0x23 && data[1] === 0x21 ? [`chmod 755 ${shellQuote(target)}`] : []),
        ...(chmod ? [`chmod ${shellQuote(chmod)} ${shellQuote(target)}`] : []),
        ...(chown ? [`chown ${shellQuote(chown)} ${shellQuote(target)}`] : []),
      ];
      if (encoded.length <= INLINE_CONTEXT_LIMITS.runChars) {
        commands.push([`mkdir -p ${shellQuote(dir)}`, `printf '%s' ${shellQuote(encoded)} | base64 -d > ${shellQuote(target)}`, ...after].join(' && '));
        continue;
      }
      // A file too large for one argument: chunks into a scratch file, each its own RUN.
      const scratch = `/tmp/.kortix-copy-${runs}.b64`;
      for (let at = 0; at < encoded.length; at += INLINE_CONTEXT_LIMITS.runChars) {
        out.push(`RUN printf '%s' ${shellQuote(encoded.slice(at, at + INLINE_CONTEXT_LIMITS.runChars))} ${at === 0 ? '>' : '>>'} ${scratch}`);
        runs += 1;
      }
      commands.push([`mkdir -p ${shellQuote(dir)}`, `base64 -d ${scratch} > ${shellQuote(target)}`, `rm -f ${scratch}`, ...after].join(' && '));
    }
    // Several small files share one RUN while it stays under the argument limit.
    let run = '';
    for (const command of commands) {
      if (run && run.length + command.length > INLINE_CONTEXT_LIMITS.runChars) {
        out.push(`RUN ${run}`);
        runs += 1;
        run = '';
      }
      run = run ? `${run} && ${command}` : command;
    }
    if (run) {
      out.push(`RUN ${run}`);
      runs += 1;
    }
    if (runs > INLINE_CONTEXT_LIMITS.runs) return { reason: `This task's Dockerfile copies too many files for a Kortix sandbox template (${runs} build steps). Give the task a prebuilt \`docker_image\`.` };
  }
  return { dockerfile: out.join('\n') };
}

// ── .harborignore ────────────────────────────────────────────────────────────

const IGNORE_FILE = '.harborignore';

/**
 * The files of a task's `tests/` or `solution/` folder that reach the sandbox:
 * Harbor's `TaskFileFilter`. Each `.harborignore` holds Git ignore patterns,
 * relative to its own folder. Walking down a path, the deepest rule that
 * matches decides; an excluded folder excludes all below it, so its nested
 * rules are never read. The ignore files themselves are never uploaded.
 */
export function withoutHarborIgnored<T extends { path: string; bytes: Uint8Array }>(files: readonly T[]): T[] {
  const rules = new Map<string, Ignore>();
  for (const file of files) {
    if (file.path === IGNORE_FILE || file.path.endsWith(`/${IGNORE_FILE}`)) {
      const dir = file.path.slice(0, -IGNORE_FILE.length).replace(/\/$/, '');
      rules.set(dir, ignore({ allowRelativePaths: true }).add(new TextDecoder().decode(file.bytes)));
    }
  }
  return files.filter((file) => !harborIgnored(file.path, rules));
}

function harborIgnored(path: string, rules: Map<string, Ignore>): boolean {
  const parts = path.split('/');
  if (parts.at(-1) === IGNORE_FILE) return true;
  if (rules.size === 0) return false;
  const active: Array<[string, Ignore]> = [];
  for (let i = 0; i < parts.length; i += 1) {
    const dir = parts.slice(0, i).join('/');
    const rule = rules.get(dir);
    if (rule) active.push([dir, rule]);
    const isDir = i < parts.length - 1;
    const candidate = parts.slice(0, i + 1).join('/');
    let excluded = false;
    for (const [base, spec] of active) {
      const relative = (base ? candidate.slice(base.length + 1) : candidate) + (isDir ? '/' : '');
      const result = spec.test(relative);
      if (result.ignored) excluded = true;
      else if (result.unignored) excluded = false;
    }
    if (excluded) return true;
  }
  return false;
}

// ── Healthcheck ──────────────────────────────────────────────────────────────

/** Where a healthcheck stands between ticks. */
export interface HealthcheckState {
  /** When the first check ran (ISO): the start period counts from here. */
  started_at: string;
  /** Consecutive failures after the start period. */
  failures: number;
  /** When the next check may run (ISO). */
  next_at: string;
}

/**
 * One healthcheck result, as Docker HEALTHCHECK counts it (Harbor's
 * `run_healthcheck`): a pass ends the check; a failure inside the start period
 * does not count and the next check comes after `start_interval_sec`; after
 * it, `retries` consecutive failures fail the check.
 */
export function healthcheckStep(
  hc: HarborHealthcheck,
  state: HealthcheckState | null,
  checkedAt: Date,
  passed: boolean,
): { outcome: 'passed' | 'failed' | 'wait'; state: HealthcheckState } {
  const started = state?.started_at ?? checkedAt.toISOString();
  const failures = state?.failures ?? 0;
  if (passed) return { outcome: 'passed', state: { started_at: started, failures, next_at: checkedAt.toISOString() } };
  const inStartPeriod = checkedAt.getTime() < Date.parse(started) + hc.startPeriodSec * 1000;
  if (inStartPeriod) {
    return { outcome: 'wait', state: { started_at: started, failures, next_at: new Date(checkedAt.getTime() + hc.startIntervalSec * 1000).toISOString() } };
  }
  const next = failures + 1;
  if (next >= hc.retries) return { outcome: 'failed', state: { started_at: started, failures: next, next_at: checkedAt.toISOString() } };
  return { outcome: 'wait', state: { started_at: started, failures: next, next_at: new Date(checkedAt.getTime() + hc.intervalSec * 1000).toISOString() } };
}

/** A glob of task names: `*` matches any run of characters, `?` one. Harbor uses fnmatch. */
export function taskNameMatches(name: string, pattern: string): boolean {
  const source = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${source}$`).test(name);
}
