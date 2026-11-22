import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// `kortix evals judge` asks the LLM gateway (/v1/llm/v1/*) to score the
// criteria and writes reward.json. The real CLI runs against a fake API that
// records each gateway request. KORTIX_FEATURE_FLAGS is what a session box sets.

const CLI_ENTRY = join(resolve(import.meta.dir, '..', '..'), 'src', 'index.ts');

interface Seen { method: string; path: string; auth: string | null; body: Record<string, unknown> | null }
let server: ReturnType<typeof Bun.serve>;
const seen: Seen[] = [];
let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'kortix-evals-judge-'));
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      seen.push({ method: req.method, path, auth: req.headers.get('authorization'), body: req.method === 'POST' ? ((await req.json()) as Record<string, unknown>) : null });
      if (path === '/v1/llm/v1/models') return Response.json({ data: [{ id: 'judge-model' }] });
      if (path === '/v1/llm/v1/chat/completions') {
        return Response.json({ choices: [{ message: { content: '{"scores": {"report": 0.5}, "reasoning": "Half done."}' } }] });
      }
      return Response.json({ error: 'Not found' }, { status: 404 });
    },
  });
});
afterAll(() => {
  server.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

test('judge lists the first gateway model, scores through chat completions and writes the reward file', async () => {
  const input = join(dir, 'report.md');
  const out = join(dir, 'reward.json');
  writeFileSync(input, 'The report.');
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !key.startsWith('KORTIX_')) env[key] = value;
  Object.assign(env, { HOME: dir, XDG_CONFIG_HOME: dir, KORTIX_NO_UPDATE_CHECK: '1', NO_COLOR: '1', KORTIX_FEATURE_FLAGS: 'evals', KORTIX_TOKEN: 'kortix_sb_test0000', KORTIX_API_URL: `http://127.0.0.1:${server.port}/v1` });
  const proc = Bun.spawn(['bun', CLI_ENTRY, 'evals', 'judge', '--criterion', 'report=The report is complete.', '--input', input, '--out', out, '--json'], { cwd: dir, env, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);

  expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
  expect(JSON.parse(stdout)).toMatchObject({ model: 'judge-model', scores: { report: 0.5 }, reasoning: 'Half done.', reward_file: out });
  expect(JSON.parse(readFileSync(out, 'utf8'))).toEqual({ report: 0.5 });
  expect(seen.map((s) => `${s.method} ${s.path}`)).toEqual(['GET /v1/llm/v1/models', 'POST /v1/llm/v1/chat/completions']);
  expect(seen.every((s) => s.auth === 'Bearer kortix_sb_test0000')).toBe(true);
  expect(seen[1]!.body).toMatchObject({ model: 'judge-model', temperature: 0 });
  expect(JSON.stringify(seen[1]!.body)).toContain('The report.');
});
