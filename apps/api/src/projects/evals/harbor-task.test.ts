import { describe, expect, test } from 'bun:test';
import { dockerfileCopies, dockerfileSteps, healthcheckStep, inlineDockerfile, renderDockerfile, parseHarborTask, withoutHarborIgnored, type HarborHealthcheck } from './harbor-task';

const base = { folderName: 'hello', instruction: 'Do it.\n', dockerfile: null, paths: ['task.toml', 'instruction.md', 'tests/test.sh', 'solution/solve.sh'] };
const parse = (taskToml: string, paths: string[] = base.paths) => parseHarborTask({ ...base, taskToml, paths });

describe('verifier mode (Harbor verifier_mode.py)', () => {
  test('omitted is shared, even with tests/Dockerfile', () => {
    expect(parse('')).toMatchObject({ verifierMode: 'shared', verifierEnvironment: null, unsupported: null });
    expect(parse('', [...base.paths, 'tests/Dockerfile'])).toMatchObject({ verifierMode: 'shared', unsupported: null });
  });
  test('[verifier.environment] implies separate; its docker_image comes first and bakes the tests', () => {
    const task = parse('[environment]\ndocker_image = "agent:1"\n[verifier.environment]\ndocker_image = "grader:1"\ncpus = 2\nmemory_mb = 1024\n[verifier.environment.env]\nA = "1"\n', [...base.paths, 'tests/Dockerfile']);
    expect(task.verifierMode).toBe('separate');
    expect(task.verifierEnvironment).toEqual({ source: 'verifier-image', dockerImage: 'grader:1', hasDockerfile: false, dockerfile: null, cpus: 2, memoryMb: 1024, storageMb: null, env: { A: '1' }, workdir: null, testsBaked: true });
  });
  test('separate without a verifier image: tests/Dockerfile, else a fresh copy of the task environment', () => {
    const dockerfile = parse('[verifier]\nenvironment_mode = "separate"\n', [...base.paths, 'tests/Dockerfile']);
    expect(dockerfile.verifierEnvironment).toMatchObject({ source: 'tests-dockerfile', dockerImage: null, hasDockerfile: true, testsBaked: true });
    const copy = parse('[environment]\ndocker_image = "agent:1"\ncpus = 4\n[environment.env]\nB = "2"\n[verifier]\nenvironment_mode = "separate"\n');
    expect(copy.verifierEnvironment).toMatchObject({ source: 'task-environment', dockerImage: 'agent:1', cpus: 4, env: { B: '2' }, testsBaked: false });
  });
  test('a verifier image task needs no tests/test.sh in its folder; shared + [verifier.environment] is refused', () => {
    expect(parse('[verifier.environment]\ndocker_image = "grader:1"\n', ['task.toml', 'instruction.md']).unsupported).toBeNull();
    expect(() => parse('[verifier]\nenvironment_mode = "separate"\n', ['task.toml', 'instruction.md'])).toThrow('no tests/test.sh');
    expect(parse('[verifier]\nenvironment_mode = "shared"\n[verifier.environment]\ncpus = 1\n').unsupported).toContain('cannot be combined');
  });
});

describe('what Kortix cannot run yet is named, not run', () => {
  test('a restricted network, at any level, or the deprecated allow_internet', () => {
    expect(parse('[environment]\nnetwork_mode = "no-network"\n').unsupported).toContain('network_mode = "no-network"');
    expect(parse('[environment]\nnetwork_mode = "allowlist"\nallowed_hosts = ["pypi.org"]\n').unsupported).toContain('allowlist');
    expect(parse('[environment]\nallow_internet = false\n').unsupported).toContain('no-network');
    expect(parse('[agent]\nnetwork_mode = "no-network"\n').unsupported).toContain('[agent]');
    expect(parse('[verifier.environment]\ndocker_image = "g"\nnetwork_mode = "no-network"\n').unsupported).toContain('[verifier.environment]');
    expect(parse('[environment]\nnetwork_mode = "public"\nallow_internet = true\n').unsupported).toBeNull();
  });
  test('MCP servers, sidecar artifacts and a multi-container verifier', () => {
    expect(parse('[[environment.mcp_servers]]\nname = "x"\nurl = "http://x"\n').unsupported).toContain('MCP');
    expect(parse('artifacts = [{ source = "/x", service = "db" }]\n').unsupported).toContain('Compose service');
    expect(parse('[verifier]\nenvironment_mode = "separate"\n', [...base.paths, 'tests/Dockerfile', 'tests/docker-compose.yaml']).unsupported).toContain('multi-container verifier');
  });
});

describe('artifacts', () => {
  test('strings and objects; a destination is normalized', () => {
    expect(parse('artifacts = ["/app/report.json", { source = "/app/out", destination = "./out/", exclude = ["*.tmp"] }]\n').artifacts).toEqual([
      { source: '/app/report.json', destination: null, exclude: [] },
      { source: '/app/out', destination: 'out', exclude: ['*.tmp'] },
    ]);
  });
  test('Harbor rejects .. anywhere, an absolute or backslash destination, and manifest.json', () => {
    expect(() => parse('artifacts = ["/app/../etc/passwd"]\n')).toThrow("'..'");
    expect(() => parse('artifacts = [{ source = "/a", destination = "/abs" }]\n')).toThrow('relative path');
    expect(() => parse('artifacts = [{ source = "/a", destination = "a\\\\b" }]\n')).toThrow('relative path');
    expect(() => parse('artifacts = [{ source = "/a", destination = "x/../../y" }]\n')).toThrow('relative path');
    expect(() => parse('artifacts = [{ source = "/a", destination = "manifest.json" }]\n')).toThrow('manifest.json');
  });
});

describe('.harborignore (Harbor TaskFileFilter)', () => {
  const file = (path: string, text = 'x') => ({ path, bytes: new TextEncoder().encode(text) });
  const kept = (files: ReturnType<typeof file>[]) => withoutHarborIgnored(files).map((f) => f.path).sort();

  test('patterns are relative to their file; the ignore files never upload', () => {
    expect(kept([file('.harborignore', '*.log\n/local/\n'), file('test.sh'), file('debug.log'), file('sub/deep.log'), file('local/a.txt'), file('sub/local/b.txt')])).toEqual(['sub/local/b.txt', 'test.sh']);
  });
  test('a nested rule re-includes a file the parent excludes by pattern', () => {
    expect(kept([file('.harborignore', '/fixtures/*.txt\n'), file('fixtures/.harborignore', '!expected.txt\n'), file('fixtures/expected.txt'), file('fixtures/draft.txt'), file('test.sh')])).toEqual(['fixtures/expected.txt', 'test.sh']);
  });
  test('an excluded folder excludes all below it, so its nested rules are never read', () => {
    expect(kept([file('.harborignore', '/fixtures/\n'), file('fixtures/.harborignore', '!expected.txt\n'), file('fixtures/expected.txt'), file('test.sh')])).toEqual(['test.sh']);
  });
  test('no ignore file: every file uploads', () => {
    expect(kept([file('a'), file('b/c')])).toEqual(['a', 'b/c']);
  });
});

describe('healthcheck (Docker HEALTHCHECK semantics)', () => {
  const hc: HarborHealthcheck = { command: 'true', intervalSec: 5, timeoutSec: 30, startPeriodSec: 10, startIntervalSec: 2, retries: 3 };
  const at = (s: number) => new Date(Date.UTC(2026, 10, 14, 0, 0, s));

  test('parsed with Harbor defaults', () => {
    expect(parse('[environment.healthcheck]\ncommand = "curl -f localhost"\n').healthcheck).toEqual({ command: 'curl -f localhost', intervalSec: 5, timeoutSec: 30, startPeriodSec: 0, startIntervalSec: 5, retries: 3 });
    expect(() => parse('[environment.healthcheck]\nretries = 2\n')).toThrow('needs a command');
  });
  test('failures in the start period do not count; then retries consecutive failures fail it', () => {
    let step = healthcheckStep(hc, null, at(0), false);
    expect(step).toEqual({ outcome: 'wait', state: { started_at: at(0).toISOString(), failures: 0, next_at: at(2).toISOString() } });
    step = healthcheckStep(hc, step.state, at(9), false);
    expect(step.state.failures).toBe(0);
    step = healthcheckStep(hc, step.state, at(10), false);
    expect(step).toMatchObject({ outcome: 'wait', state: { failures: 1, next_at: at(15).toISOString() } });
    step = healthcheckStep(hc, step.state, at(15), false);
    expect(step.outcome).toBe('wait');
    expect(healthcheckStep(hc, step.state, at(20), false).outcome).toBe('failed');
  });
  test('one pass ends it, at any point', () => {
    const waiting = healthcheckStep(hc, null, at(12), false).state;
    expect(healthcheckStep(hc, { ...waiting, failures: 2 }, at(20), true).outcome).toBe('passed');
  });
});

describe('a Dockerfile builds without a build context', () => {
  const steps = (text: string, file = 'environment/Dockerfile') => {
    const read = dockerfileSteps(text, file);
    if ('reason' in read) throw new Error(read.reason);
    return read;
  };
  test('FROM, RUN, WORKDIR, ENV, COPY --from and ADD <url> copy nothing and stay as written', () => {
    const text = 'FROM golang:1.22 AS build\nRUN go build \\\n  -o /x .\nFROM ubuntu:24.04\nWORKDIR /app\nCOPY --from=build /x /usr/bin/x\nADD https://example.test/a.tgz /opt/\n';
    const read = steps(text);
    expect(dockerfileCopies(read)).toBe(false);
    expect(renderDockerfile(read)).toBe(text);
  });
  test("tests/Dockerfile drops Harbor's COPY . /tests (the runner uploads tests/ there)", () => {
    expect(renderDockerfile(steps('FROM ubuntu:24.04\nWORKDIR /app\nCOPY . /tests/\n', 'tests/Dockerfile'))).toBe('FROM ubuntu:24.04\nWORKDIR /app\n');
  });
  test('a local archive ADD, a heredoc and a variable path are named as the reason', () => {
    for (const line of ['ADD data.tar.gz /data', 'COPY <<EOF /a.txt', 'COPY $SRC /app']) {
      const read = dockerfileSteps(`FROM ubuntu:24.04\n${line}\n`, 'environment/Dockerfile');
      expect('reason' in read && read.reason).toContain(line.slice(0, 10));
    }
  });
  test("COPY of the task's files becomes RUN steps that write the same paths, by Docker's rules", () => {
    const context = new Map<string, Uint8Array>([
      ['workspace/main.py', new TextEncoder().encode("print('hi')\n")],
      ['workspace/sub/run.sh', new TextEncoder().encode('#!/bin/sh\necho ok\n')],
      ['config.json', new TextEncoder().encode('{}')],
    ]);
    const built = inlineDockerfile(steps('FROM python:3.12\nWORKDIR /app\nCOPY workspace/ ./\nCOPY --chown=1000:1000 config.json /etc/app.json\nCOPY ["config.json", "workspace/main.py", "/opt/both/"]\n'), context);
    if ('reason' in built) throw new Error(built.reason);
    const runs = built.dockerfile.split('\n').filter((line) => line.startsWith('RUN '));
    expect(built.dockerfile.startsWith('FROM python:3.12\nWORKDIR /app\nRUN ')).toBe(true);
    // A directory source copies its contents into dest, relative to WORKDIR.
    expect(runs[0]).toContain(`> './main.py'`);
    expect(runs[0]).toContain(`mkdir -p './sub'`);
    expect(runs[0]).toContain(`chmod 755 './sub/run.sh'`);
    expect(runs[0]).toContain(Buffer.from("print('hi')\n").toString('base64'));
    // A single file onto a file path, with its owner.
    expect(runs[1]).toContain(`> '/etc/app.json' && chown '1000:1000' '/etc/app.json'`);
    // Several sources: dest is a directory.
    expect(runs[2]).toContain(`> '/opt/both/config.json'`);
    expect(runs[2]).toContain(`> '/opt/both/main.py'`);
  });
  test('a file larger than one shell argument is written in chunks; a missing source and too much data are refused', () => {
    const big = new Uint8Array(200 * 1024).fill(65);
    const built = inlineDockerfile(steps('FROM ubuntu:24.04\nCOPY big.bin /data/big.bin\n'), new Map([['big.bin', big]]));
    if ('reason' in built) throw new Error(built.reason);
    const lines = built.dockerfile.split('\n');
    expect(lines.filter((line) => line.includes('/tmp/.kortix-copy-0.b64')).length).toBeGreaterThan(3);
    expect(lines.every((line) => line.length < 70 * 1024)).toBe(true);
    expect(lines.filter(Boolean).pop()).toContain(`base64 -d /tmp/.kortix-copy-0.b64 > '/data/big.bin'`);
    expect('reason' in inlineDockerfile(steps('FROM ubuntu:24.04\nCOPY nope/ /x/\n'), new Map())).toBe(true);
    const huge = new Map([['a.bin', new Uint8Array(2 * 1024 * 1024)]]);
    expect('reason' in inlineDockerfile(steps('FROM ubuntu:24.04\nCOPY a.bin /a.bin\n'), huge)).toBe(true);
  });
});
