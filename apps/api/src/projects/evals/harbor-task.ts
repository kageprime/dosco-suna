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
  /** Why Kortix cannot run this task, or null. */
  unsupported: string | null;
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

export interface HarborTaskFiles {
  /** The folder name of the task. */
  folderName: string;
  taskToml: string | null;
  instruction: string | null;
  dockerfile: string | null;
  /** Paths of the task folder, relative to it. */
  paths: readonly string[];
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
  const multiStep = Array.isArray(toml.steps) || files.paths.some((path) => path.startsWith('steps/'));
  if (!multiStep && files.instruction === null) throw new HarborTaskError(`${files.folderName}: no instruction.md.`);
  if (!multiStep && !has('tests/test.sh')) throw new HarborTaskError(`${files.folderName}: no tests/test.sh.`);

  const environment = table(toml.environment);
  const verifier = table(toml.verifier);
  const agent = table(toml.agent);
  const dockerImage = typeof environment.docker_image === 'string' && environment.docker_image.trim() ? environment.docker_image.trim() : null;
  const hasCompose = files.paths.some((path) => /^environment\/docker-compose\.ya?ml$/.test(path));

  let unsupported: string | null = null;
  if (multiStep) unsupported = 'Multi-step tasks (`[[steps]]`) do not run on Kortix yet.';
  else if (environment.os === 'windows') unsupported = 'Windows tasks do not run on Kortix.';
  else if (hasCompose) unsupported = 'Multi-container tasks (`environment/docker-compose.yaml`) do not run on Kortix yet.';
  else if (positive(environment.gpus) || environment.tpu) unsupported = 'GPU and TPU tasks do not run on Kortix.';
  else if (verifier.environment_mode === 'separate' || isTable(verifier.environment) || has('tests/Dockerfile')) {
    unsupported = 'A separate verifier environment does not run on Kortix yet. Set `environment_mode = "shared"` under `[verifier]`.';
  }

  const taskName = typeof table(toml.task).name === 'string' ? String(table(toml.task).name).trim() : '';
  return {
    name: taskName || files.folderName,
    instruction: files.instruction === null ? '' : cleanInstruction(files.instruction),
    agentTimeoutSec: positive(agent.timeout_sec) ?? EVAL_LIMITS.agent_timeout_sec_default,
    verifierTimeoutSec: positive(verifier.timeout_sec) ?? EVAL_LIMITS.verifier_timeout_sec_default,
    buildTimeoutSec: positive(environment.build_timeout_sec) ?? 600,
    dockerImage,
    hasDockerfile: has('environment/Dockerfile'),
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
    unsupported,
  };
}

/** A glob of task names: `*` matches any run of characters, `?` one. Harbor uses fnmatch. */
export function taskNameMatches(name: string, pattern: string): boolean {
  const source = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${source}$`).test(name);
}
