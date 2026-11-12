import { describe, expect, it } from 'vitest';
import { readWorkflow as read } from '../src/fixtures/repo';

// Three deploy-dev surfaces boot TypeScript source under bun at runtime
// (`CMD bun run src/index.ts`): the API, the gateway, and the web app whose
// next.config sets `ignoreBuildErrors: true`. A bun image build resolves
// named exports only when the task starts, so a renamed export can pass every
// per-PR check and still crash-loop dev's ECS tasks after the squash merge:
// on 2026-11-10 three Deploy Dev runs rolled back on
// `SyntaxError: Export named 'deadCredentialLogDecision' not found` after two
// separately-green PRs (one added a caller, one renamed the function) landed
// on dev in either order. The typecheck-deploy-tree job runs tsgo on the
// exact tree a dispatch would boot, before any ECS service takes it.

const JOB = 'typecheck-deploy-tree';

// The block of a workflow belonging to one top-level job id (the
// image-build-speed-workflow convention).
const jobBlock = (workflow: string, jobId: string): string => {
  const start = workflow.indexOf(`\n  ${jobId}:\n`);
  expect(start, `job ${jobId} is missing`).toBeGreaterThan(-1);
  const rest = workflow.slice(start + 1);
  const next = rest.search(/\n {2}[a-z][a-z0-9-]*:\n/);
  return next === -1 ? rest : rest.slice(0, next);
};

describe('deploy-dev typechecks the tree it boots', () => {
  const source = read('deploy-dev.yml');

  it('the typecheck job runs every deployed TS surface', () => {
    const job = jobBlock(source, JOB);
    // The exact commands the packages lanes run, so a lane and the deploy
    // cannot drift apart on what they consider type-clean.
    expect(job).toContain('pnpm --filter kortix-api typecheck');
    expect(job).toContain('pnpm --filter @kortix/llm-gateway-server typecheck');
    expect(job).toContain('pnpm --filter Kortix-Computer-Frontend typecheck');
  });

  it.each(['deploy-api-ecs', 'deploy-gateway-ecs', 'deploy-web-ecs'])(
    '%s waits for the typecheck',
    (deploy) => {
      const block = jobBlock(source, deploy);
      expect(block).toMatch(new RegExp(`needs: \\[[^\\]]*${JOB}`));
    },
  );
});
