import { describe, expect, mock, test } from 'bun:test';

mock.module('../../platform/providers', () => ({
  isProviderName: (name: string) => name === 'platinum',
  getProvider: () => ({
    exec: async (externalId: string, command: string[], options: { timeoutMs: number }) => ({
      exitCode: 0,
      stdout: JSON.stringify({ externalId, command, options }),
      stderr: '',
    }),
  }),
}));

const { boxOps } = await import('./box');

describe('live eval box channel', () => {
  test('returns the same live channel and forwards provider exec arguments', async () => {
    const first = boxOps();
    expect(boxOps()).toBe(first);
    const result = await first.exec({ provider: 'platinum', externalId: 'synthetic-box' }, "echo 'test'", 1234);
    expect(result.exitCode).toBe(0);
    const forwarded = JSON.parse(result.stdout);
    expect(forwarded.externalId).toBe('synthetic-box');
    expect(forwarded.command.slice(0, 2)).toEqual(['bash', '-c']);
    expect(forwarded.command[2]).toContain('sudo -n bash');
    expect(forwarded.options).toEqual({ timeoutMs: 1234 });
  });

  test('unsupported providers fail before executing', async () => {
    await expect(boxOps().exec({ provider: 'unsupported', externalId: 'synthetic-box' }, 'true'))
      .rejects.toThrow('Sandbox provider unsupported is not supported.');
  });
});
