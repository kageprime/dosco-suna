import { describe, expect, test } from 'bun:test';

import { PROD_TARGET, loopPrompt, setupGuide, setupHostName, setupPromptFor, setupTarget } from './setup-guide';

// A prompt copied on a deployment must name that deployment's guide, and the
// guide must point the CLI at that deployment's API (founder call 2026-11-10).
describe('setup target', () => {
  test('production, absent values and the production origin all give the production target', () => {
    expect(setupTarget(undefined, undefined)).toEqual(PROD_TARGET);
    expect(setupTarget('https://kortix.com/', 'https://api.kortix.com/v1')).toEqual(PROD_TARGET);
  });

  test('dev, a local stack and a root-relative backend each point at themselves', () => {
    expect(setupTarget('https://dev.kortix.com', 'https://dev-api.kortix.com/v1')).toEqual({ origin: 'https://dev.kortix.com', apiBase: 'https://dev-api.kortix.com' });
    expect(setupTarget('http://localhost:14800', 'http://localhost:14808/v1')).toEqual({ origin: 'http://localhost:14800', apiBase: 'http://localhost:14808' });
    expect(setupTarget('https://kortix.example.com', '/v1')).toEqual({ origin: 'https://kortix.example.com', apiBase: 'https://kortix.example.com' });
  });

  test('prompts name the guide of their own deployment', () => {
    const local = setupTarget('http://localhost:14800', 'http://localhost:14808/v1');
    expect(setupPromptFor()).toContain('https://kortix.com/setup.md');
    expect(setupPromptFor(local)).toContain('http://localhost:14800/setup.md');
    expect(setupPromptFor(local)).not.toContain('kortix.com');
    expect(loopPrompt({ id: 'sales', name: 'Sales Factory' }, local)).toContain('http://localhost:14800/setup.md');
  });

  test('the guide off production installs from that origin and selects a CLI host for its API', () => {
    const dev = setupTarget('https://dev.kortix.com', 'https://dev-api.kortix.com/v1');
    const guide = setupGuide(dev);
    expect(setupHostName(dev)).toBe('dev-kortix-com');
    expect(guide).toContain('curl -fsSL https://dev.kortix.com/install | KORTIX_CHANNEL=dev bash');
    expect(guide).toContain('kortix hosts add dev-kortix-com --url https://dev-api.kortix.com');
    expect(guide).toContain('kortix hosts use dev-kortix-com');
    expect(setupGuide()).toContain('curl -fsSL https://kortix.com/install | bash');
    expect(setupGuide()).not.toContain('kortix hosts use');
    // The MCP server the guide registers is this deployment's own.
    expect(guide).toContain('claude mcp add --transport http kortix https://dev-api.kortix.com/v1/mcp');
    expect(setupGuide()).toContain('codex mcp add kortix --url https://api.kortix.com/v1/mcp');
  });
});
