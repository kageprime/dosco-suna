import { describe, expect, test } from 'bun:test';
import {
  COMPILED_AGENT_CONFIG_ENV,
  COMPILED_AGENT_CONFIG_GZ_PARTS_ENV,
  MAX_ENV_STRING_BYTES,
  envStringBytes,
  readCompiledAgentConfigEnv,
} from '@kortix/api-contract/compiled-agent-config-env';
import { agentConfigEtag } from './compile-agent-config';
import {
  auditRelayEnvPassthrough,
  buildSessionRuntimeEnv,
} from './session-runtime-env';

/**
 * Compiled agent config JSON whose `KORTIX_COMPILED_AGENT_CONFIG=<json>\0` is
 * exactly `envBytes` long: agents with prompt-length prose, the last one
 * trimmed to land on the size.
 */
function oversizedCompiledConfig(envBytes: number): string {
  const words = 'agent reads the repository plans then edits files and reports what changed with a short summary'.split(' ');
  const prose = (seed: number, chars: number) => {
    let out = '';
    for (let i = seed; out.length < chars; i = (i * 1103515245 + 12345) % 2147483648) out += `${words[i % words.length]} `;
    return out.slice(0, chars);
  };
  const config = { default_agent: 'build', agent: {} as Record<string, { mode: string; prompt: string; permission: unknown }> };
  const size = () => envStringBytes(COMPILED_AGENT_CONFIG_ENV, JSON.stringify(config));
  let index = 0;
  while (size() < envBytes - 20_000) {
    config.agent[`agent-${index}`] = { mode: 'subagent', prompt: prose(index + 1, 15_000), permission: { bash: 'ask' } };
    index++;
  }
  config.agent.build = { mode: 'primary', prompt: '', permission: { edit: 'allow' } };
  config.agent.build.prompt = prose(7, envBytes - size());
  return JSON.stringify(config);
}

const BASE_INPUT = {
  projectId: 'proj-1',
  sessionId: 'sess-1',
  repoUrl: 'https://example.test/acme/repo.git',
  baseRef: 'main',
  agentName: 'default',
  apiUrl: 'https://api.kortix.test/v1',
};

describe('buildSessionRuntimeEnv — server-claimed initial turn', () => {
  test('never injects the prompt or turn-ledger identity', () => {
    const env = buildSessionRuntimeEnv(BASE_INPUT);

    expect(env).not.toHaveProperty('KORTIX_INITIAL_PROMPT');
    expect(env).not.toHaveProperty('KORTIX_INITIAL_TURN_TOKEN');
    expect(env).not.toHaveProperty('KORTIX_INITIAL_TURN_MESSAGE_ID');
  });

});

describe('buildSessionRuntimeEnv — release identity', () => {
  test('the box gets the release the API serves and its commit, so the CLI reports that release', () => {
    const env = buildSessionRuntimeEnv({ ...BASE_INPUT, release: { version: '0.15.6', commit: 'a1b2c3d4e5f6' } });

    expect(env.KORTIX_RELEASE_VERSION).toBe('0.15.6');
    expect(env.KORTIX_RELEASE_COMMIT).toBe('a1b2c3d4e5f6');
  });

  test('an API without a build commit sends neither', () => {
    const env = buildSessionRuntimeEnv({ ...BASE_INPUT, release: { version: 'dev', commit: '' } });

    expect('KORTIX_RELEASE_VERSION' in env).toBe(false);
    expect('KORTIX_RELEASE_COMMIT' in env).toBe(false);
  });
});

describe('buildSessionRuntimeEnv — workspace id', () => {
  test('the box gets KORTIX_PROJECT_ID only, so a script that sets KORTIX_PROJECT_ID=<other> still wins', () => {
    // The CLI reads KORTIX_WORKSPACE_ID before KORTIX_PROJECT_ID. An injected
    // KORTIX_WORKSPACE_ID would outrank an older script's own
    // KORTIX_PROJECT_ID override and silently target the box's project.
    const env = buildSessionRuntimeEnv(BASE_INPUT);

    expect(env.KORTIX_PROJECT_ID).toBe(BASE_INPUT.projectId);
    expect('KORTIX_WORKSPACE_ID' in env).toBe(false);
  });
});

describe('buildSessionRuntimeEnv — KORTIX_HARNESS', () => {
  test('every new box runs pi: KORTIX_HARNESS=pi, next to the same model and compiled config keys', () => {
    // An unset KORTIX_HARNESS marks a box OpenCode booted before the sunset, so the key is never left out.
    expect(buildSessionRuntimeEnv(BASE_INPUT).KORTIX_HARNESS).toBe('pi');
    const env = buildSessionRuntimeEnv({
      ...BASE_INPUT,
      sessionModel: 'kortix/claude-sonnet-5',
      compiledAgentConfig: JSON.stringify({ agent: { build: { prompt: 'x' } } }),
    });
    expect(env.KORTIX_HARNESS).toBe('pi');
    // D3: the harness-neutral name, plus the pre-W3 name for an older daemon.
    expect(env.KORTIX_MODEL).toBe('kortix/claude-sonnet-5');
    expect(env.KORTIX_MODEL).toBe('kortix/claude-sonnet-5');
    expect(env.KORTIX_COMPILED_AGENT_CONFIG).toContain('"build"');
    expect(env.KORTIX_BOOTSTRAP_RUNTIME_SESSION).toBe('1');
  });
});

describe('buildSessionRuntimeEnv — KORTIX_PI_PACKAGES', () => {
  const packages = ['npm:pi-web-access@0.30.0', { source: './.kortix/pi/audit.ts' }];

  test('a pi session carries the project packages as JSON', () => {
    const env = buildSessionRuntimeEnv({ ...BASE_INPUT, piPackages: packages });
    expect(JSON.parse(env.KORTIX_PI_PACKAGES!)).toEqual(packages);
  });

  test('a built bundle travels as its URL and digest, to a pi session only', () => {
    const bundle = { digest: 'a'.repeat(64), url: 'https://bucket.example/pi-packages/x.tar.gz?sig=1', fallbackUrl: 'https://bucket.example/pi-packages/x.node_modules.tar.gz?sig=2' };
    const env = buildSessionRuntimeEnv({ ...BASE_INPUT, piPackages: packages, piPackagesBundle: bundle });
    expect(env.KORTIX_PI_PACKAGES_BUNDLE_URL).toBe(bundle.url);
    expect(env.KORTIX_PI_PACKAGES_BUNDLE_DIGEST).toBe(bundle.digest);
    expect(env.KORTIX_PI_PACKAGES_FALLBACK_URL).toBe(bundle.fallbackUrl);
    expect(buildSessionRuntimeEnv({ ...BASE_INPUT, piPackages: packages, piPackagesBundle: null })).not.toHaveProperty('KORTIX_PI_PACKAGES_BUNDLE_URL');
  });

  test('no key for a session without packages', () => {
    expect(buildSessionRuntimeEnv({ ...BASE_INPUT, piPackages: [] })).not.toHaveProperty('KORTIX_PI_PACKAGES');
    expect(buildSessionRuntimeEnv(BASE_INPUT)).not.toHaveProperty('KORTIX_PI_PACKAGES');
  });
});

describe('buildSessionRuntimeEnv — KORTIX_PI_CODEMODE', () => {
  test('a pi session carries the manifest value; none leaves the daemon default', () => {
    expect(buildSessionRuntimeEnv({ ...BASE_INPUT, piCodemode: 'only' }).KORTIX_PI_CODEMODE).toBe('only');
    expect(buildSessionRuntimeEnv({ ...BASE_INPUT, piCodemode: 'off' }).KORTIX_PI_CODEMODE).toBe('off');
    expect(buildSessionRuntimeEnv({ ...BASE_INPUT, piCodemode: null })).not.toHaveProperty('KORTIX_PI_CODEMODE');
  });
});

describe('buildSessionRuntimeEnv — KORTIX_PI_CONTEXT', () => {
  test('only `summary` is sent; `record` and none leave the daemon default (the context record)', () => {
    expect(buildSessionRuntimeEnv({ ...BASE_INPUT, piContext: 'summary' }).KORTIX_PI_CONTEXT).toBe('summary');
    expect(buildSessionRuntimeEnv({ ...BASE_INPUT, piContext: 'record' })).not.toHaveProperty('KORTIX_PI_CONTEXT');
    expect(buildSessionRuntimeEnv({ ...BASE_INPUT, piContext: null })).not.toHaveProperty('KORTIX_PI_CONTEXT');
  });
});

describe('buildSessionRuntimeEnv — KORTIX_COMPILED_AGENT_CONFIG', () => {
  test('omits the key entirely for a v1 project (compiledAgentConfig absent) — byte-for-byte unaffected', () => {
    const env = buildSessionRuntimeEnv(BASE_INPUT);
    expect(env).not.toHaveProperty('KORTIX_COMPILED_AGENT_CONFIG');
  });

  test('omits the key when compiledAgentConfig is explicitly null', () => {
    const env = buildSessionRuntimeEnv({ ...BASE_INPUT, compiledAgentConfig: null });
    expect(env).not.toHaveProperty('KORTIX_COMPILED_AGENT_CONFIG');
  });

  test('carries the compiled JSON through verbatim for a v2 project', () => {
    const compiled = JSON.stringify({ agent: { support: { mode: 'primary' } } });
    const env = buildSessionRuntimeEnv({ ...BASE_INPUT, compiledAgentConfig: compiled });
    expect(env.KORTIX_COMPILED_AGENT_CONFIG).toBe(compiled);
  });

  test('coexists with KORTIX_MODEL — the per-session override key is unaffected', () => {
    const compiled = JSON.stringify({ agent: {} });
    const env = buildSessionRuntimeEnv({
      ...BASE_INPUT,
      compiledAgentConfig: compiled,
      sessionModel: 'anthropic/claude-opus-4-8',
    });
    expect(env.KORTIX_MODEL).toBe('anthropic/claude-opus-4-8');
    expect(env.KORTIX_COMPILED_AGENT_CONFIG).toBe(compiled);
  });

  // Platinum prod, 2026-10-14: every create whose `KORTIX_COMPILED_AGENT_CONFIG=…\0`
  // was over 131,072 bytes failed to exec in the guest (kortix-ai/platinum#1569).
  test.each([131_734, 269_979])(
    'a %d-byte config leaves the create with no env string over the exec limit, and the etag names the JSON',
    (envBytes) => {
      const compiled = oversizedCompiledConfig(envBytes);
      expect(envStringBytes(COMPILED_AGENT_CONFIG_ENV, compiled)).toBe(envBytes);

      const env = buildSessionRuntimeEnv({ ...BASE_INPUT, compiledAgentConfig: compiled });

      for (const [name, value] of Object.entries(env)) {
        expect(envStringBytes(name, value), name).toBeLessThanOrEqual(MAX_ENV_STRING_BYTES);
      }
      expect(env).not.toHaveProperty(COMPILED_AGENT_CONFIG_ENV);
      expect(env[COMPILED_AGENT_CONFIG_GZ_PARTS_ENV]).toBe('1');
      expect(readCompiledAgentConfigEnv(env)).toBe(compiled);
      // The etag stays the hash of the JSON, so the box reports the same
      // identity whichever form the config travelled in.
      expect(env.KORTIX_COMPILED_AGENT_CONFIG_ETAG).toBe(agentConfigEtag(compiled)!);
    },
  );

  test('a config at the exec limit still travels raw, for a daemon that predates the gzip form', () => {
    const compiled = oversizedCompiledConfig(MAX_ENV_STRING_BYTES);
    const env = buildSessionRuntimeEnv({ ...BASE_INPUT, compiledAgentConfig: compiled });
    expect(env.KORTIX_COMPILED_AGENT_CONFIG).toBe(compiled);
    expect(Object.keys(env).filter((name) => name.startsWith('KORTIX_COMPILED_AGENT_CONFIG_GZ'))).toEqual([]);
  });

  test('ignores legacy attribution input and emits no attribution variables', () => {
    const env = buildSessionRuntimeEnv({
      ...BASE_INPUT,
      originRef: 'legacy-reference',
    } as Parameters<typeof buildSessionRuntimeEnv>[0]);

    expect(env).not.toHaveProperty('KORTIX_END_USER_REF');
    expect(env).not.toHaveProperty('KORTIX_ORIGIN_REF');
  });
});

describe('buildSessionRuntimeEnv — no checkout at boot', () => {
  test('every session gets the repository coordinates and auto-clone off, and no clone-only key', () => {
    const env = buildSessionRuntimeEnv(BASE_INPUT);
    // Where the agent clones from and the one branch the Git proxy lets it push.
    expect(env.KORTIX_REPO_URL).toBe(BASE_INPUT.repoUrl);
    expect(env.KORTIX_DEFAULT_BRANCH).toBe(BASE_INPUT.baseRef);
    expect(env.KORTIX_BASE_REF).toBe(BASE_INPUT.baseRef);
    expect(env.KORTIX_BRANCH_NAME).toBe(BASE_INPUT.sessionId);
    // A daemon from before 2026-11-08 clones only on '1'.
    expect(env.KORTIX_PROJECT_AUTO_CLONE).toBe('0');
    for (const key of [
      'KORTIX_REPOSITORY_ACCESS',
      'KORTIX_SESSION_FRESH',
      'KORTIX_SESSION_BRANCH_RESTORE',
      'KORTIX_BASE_SHA',
      'KORTIX_GIT_DELTA_BUNDLE_BASE64',
      'KORTIX_GIT_DELTA_BUNDLE_REMOTE',
      'KORTIX_PROJECT_SNAPSHOT_MODE',
      'KORTIX_PROJECT_SNAPSHOT_PIN',
      'KORTIX_PROJECT_SNAPSHOT_DESCRIPTOR',
    ]) {
      expect(env).not.toHaveProperty(key);
    }
  });
});

describe('audit relay emission knobs', () => {
  test('forwards nothing when the operator set nothing', () => {
    expect(auditRelayEnvPassthrough({})).toEqual({});
    expect(buildSessionRuntimeEnv(BASE_INPUT)).not.toHaveProperty('KORTIX_AUDIT_RELAY_BATCH_SIZE');
  });

  test('forwards each knob the operator set, including an empty drop list', () => {
    expect(
      auditRelayEnvPassthrough({
        KORTIX_AUDIT_RELAY_BATCH_SIZE: '100',
        KORTIX_AUDIT_RELAY_FLUSH_MS: '5000',
        // An empty list means "drop nothing" — a real setting, not an absence.
        KORTIX_AUDIT_RELAY_DROP_TYPES: '',
        KORTIX_AUDIT_RELAY_COALESCE: '0',
        KORTIX_UNRELATED: 'x',
      }),
    ).toEqual({
      KORTIX_AUDIT_RELAY_BATCH_SIZE: '100',
      KORTIX_AUDIT_RELAY_FLUSH_MS: '5000',
      KORTIX_AUDIT_RELAY_DROP_TYPES: '',
      KORTIX_AUDIT_RELAY_COALESCE: '0',
    });
  });
});

describe('buildSessionRuntimeEnv — KORTIX_WORKSPACE_SETUP', () => {
  const decode = (env: Record<string, string>) => JSON.parse(Buffer.from(env.KORTIX_WORKSPACE_SETUP!, 'base64').toString('utf8'));
  const spec = { repos: [{ path: '/workspace', sparse: ['apps/web'] }], setup: [{ run: 'pnpm install' }, { run: 'pnpm build', cwd: 'apps/web' }] };

  test('no workspace declared: no key, nothing is prepared', () => {
    expect(buildSessionRuntimeEnv(BASE_INPUT)).not.toHaveProperty('KORTIX_WORKSPACE_SETUP');
    expect(buildSessionRuntimeEnv({ ...BASE_INPUT, workspaceSetup: null })).not.toHaveProperty('KORTIX_WORKSPACE_SETUP');
  });

  test('with repository access the box gets the clones and the setup', () => {
    expect(decode(buildSessionRuntimeEnv({ ...BASE_INPUT, workspaceSetup: spec, repositoryAccess: true }))).toEqual({ version: 1, ...spec });
  });

  test('without repository access the clones are withheld, the setup still runs, and the box is told why', () => {
    const body = decode(buildSessionRuntimeEnv({ ...BASE_INPUT, workspaceSetup: spec, repositoryAccess: false }));
    expect(body.repos).toEqual([]);
    expect(body.setup).toEqual(spec.setup);
    expect(body.repos_skipped).toContain('project.gitops.read');
  });
});
