/**
 * The access rules of a colleague My Kortix starts (colleague-access.ts): what
 * a start may ask for, the key an approval matches, the grant the colleague
 * gets, and what a member may allow without a workspace manager.
 */
import { describe, expect, test } from 'bun:test';
import type { AgentGrant } from '@kortix/db';
import { extractAgents } from '../agents';
import { parseManifestString } from '../triggers';
import {
  COLLEAGUE_ACCESS_MAX_ITEMS,
  colleagueAccessHash,
  describeColleagueAccess,
  itemsNoAgentHolds,
  parseColleagueAccess,
  withColleagueAccess,
} from './colleague-access';

const myKortix: AgentGrant = { agent: 'mykortix', permissions: 'all', connectors: [], env: [] };

describe('parseColleagueAccess', () => {
  test('absent, null and two empty lists ask for nothing', () => {
    expect(parseColleagueAccess(undefined)).toEqual({ ok: true, value: null });
    expect(parseColleagueAccess(null)).toEqual({ ok: true, value: null });
    expect(parseColleagueAccess({ connectors: [], secrets: [] })).toEqual({ ok: true, value: null });
  });

  test('lists come back sorted, without duplicates, connectors as canonical slugs', () => {
    expect(parseColleagueAccess({ connectors: ['slack', 'gmail', 'gmail', ' notion '], secrets: ['STRIPE_KEY', 'A_KEY'] })).toEqual({
      ok: true,
      value: { connectors: ['gmail', 'kortix_slack', 'notion'], secrets: ['A_KEY', 'STRIPE_KEY'] },
    });
  });

  test('a wrong shape is refused with the field it names', () => {
    expect(parseColleagueAccess('gmail')).toEqual({ ok: false, error: 'colleague_access must be an object' });
    expect(parseColleagueAccess({ tools: ['bash'] })).toEqual({ ok: false, error: 'colleague_access takes connectors and secrets, not tools' });
    expect(parseColleagueAccess({ connectors: 'gmail' })).toEqual({ ok: false, error: 'colleague_access.connectors must be an array of names' });
    expect(parseColleagueAccess({ secrets: ['$(whoami)'] }).ok).toBe(false);
    expect(parseColleagueAccess({ secrets: [''] }).ok).toBe(false);
    const many = Array.from({ length: COLLEAGUE_ACCESS_MAX_ITEMS + 1 }, (_, i) => `c${i}`);
    expect(parseColleagueAccess({ connectors: many })).toEqual({ ok: false, error: `colleague_access.connectors takes at most ${COLLEAGUE_ACCESS_MAX_ITEMS} names` });
  });
});

describe('colleagueAccessHash', () => {
  test('the same list matches whatever its order and secret case', () => {
    const a = colleagueAccessHash({ connectors: ['gmail', 'notion'], secrets: ['A_KEY', 'stripe_key'] });
    const b = colleagueAccessHash({ connectors: ['gmail', 'notion'], secrets: ['STRIPE_KEY', 'a_key'] });
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });

  test('a different list never matches: an extra item, or a connector named as a secret', () => {
    const base = colleagueAccessHash({ connectors: ['gmail'], secrets: [] });
    expect(colleagueAccessHash({ connectors: ['gmail', 'notion'], secrets: [] })).not.toBe(base);
    expect(colleagueAccessHash({ connectors: [], secrets: ['gmail'] })).not.toBe(base);
  });
});

describe('withColleagueAccess', () => {
  test('no list: My Kortix keeps its own grant', () => {
    expect(withColleagueAccess(myKortix, null)).toEqual(myKortix);
  });

  test('a list adds exactly its connectors and secrets, and nothing else', () => {
    expect(withColleagueAccess(myKortix, { connectors: ['gmail'], secrets: ['STRIPE_KEY'] })).toEqual({
      agent: 'mykortix',
      permissions: 'all',
      connectors: ['gmail'],
      env: ['STRIPE_KEY'],
    });
  });

  test('it never narrows: "all", and an absent env (every secret), stay as they are', () => {
    const wide: AgentGrant = { agent: 'x', permissions: [], connectors: 'all' };
    expect(withColleagueAccess(wide, { connectors: ['gmail'], secrets: ['STRIPE_KEY'] })).toEqual({ ...wide, env: 'all' });
  });
});

describe('itemsNoAgentHolds: what a member may allow without a workspace manager', () => {
  const loaded = extractAgents(
    parseManifestString(
      [
        'default_agent: writer',
        'agents:',
        '  writer:',
        '    connectors: [gmail]',
        '    secrets: [STRIPE_KEY]',
        '  archivist:',
        '    enabled: false',
        '    connectors: [notion]',
        '    secrets: [NOTION_KEY]',
      ].join('\n'),
      'kortix.yaml',
    ),
  );

  test('an item some enabled agent holds is allowed; one only a disabled agent holds is not', () => {
    expect(loaded.errors).toEqual([]);
    expect(itemsNoAgentHolds(loaded, { connectors: ['gmail'], secrets: ['stripe_key'] })).toEqual([]);
    expect(itemsNoAgentHolds(loaded, { connectors: ['gmail', 'notion'], secrets: ['STRIPE_KEY', 'NOTION_KEY'] })).toEqual([
      'connector notion',
      'secret NOTION_KEY',
    ]);
  });

  test('a project with no per-agent grants holds everything', () => {
    expect(itemsNoAgentHolds({ specs: [], errors: [] }, { connectors: ['notion'], secrets: ['ANY'] })).toEqual([]);
  });
});

test('describeColleagueAccess names each kind once, singular or plural', () => {
  expect(describeColleagueAccess({ connectors: ['gmail'], secrets: [] })).toBe('connector gmail');
  expect(describeColleagueAccess({ connectors: ['gmail', 'notion'], secrets: ['STRIPE_KEY'] })).toBe(
    'connectors gmail, notion and secret STRIPE_KEY',
  );
});
