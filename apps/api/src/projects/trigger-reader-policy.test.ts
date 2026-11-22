import { describe, expect, test } from 'bun:test';
import { extractTriggers, triggerSpecToFlatEntry, triggerSpecToOnRunEntry } from './triggers';
import { triggerReaderStanding } from './trigger-reader-policy';
import { validateManifest, type TriggerReaders } from '@kortix/manifest-schema';

const policy = { humans: 'members' as const, agents: ['watchdog', 'my-kortix'] };
const metadata = { source: 'trigger:cron', trigger_kind: 'git', trigger_slug: 'daily', trigger_session_readers: policy };
const human = { kind: 'human' as const, member: true };
const session = { metadata, spaceKind: null, tombstoned: false };

describe('trigger-only reader standing', () => {
  test('current human members read but removed members do not', () => {
    expect(triggerReaderStanding(session, human)).toBe(true);
    expect(triggerReaderStanding(session, { ...human, member: false })).toBe(false);
  });
  test('named agents read only by their own identity; no implicit My Kortix grant', () => {
    expect(triggerReaderStanding(session, { kind: 'agent', name: 'watchdog' })).toBe(true);
    expect(triggerReaderStanding(session, { kind: 'agent', name: 'other' })).toBe(false);
    expect(triggerReaderStanding({ ...session, metadata: { ...metadata, trigger_session_readers: { humans: 'members', agents: [] } } }, { kind: 'agent', name: 'my-kortix' })).toBe(false);
  });
  test('no policy, forged partial trigger markers, DM and tombstones stay protected', () => {
    for (const row of [
      { ...session, metadata: {} },
      { ...session, metadata: { trigger_session_readers: policy } },
      { ...session, spaceKind: 'dm' },
      { ...session, tombstoned: true },
    ]) expect(triggerReaderStanding(row, human)).toBe(false);
  });
});

describe('declarative readers', () => {
  const trigger = { slug: 'daily', type: 'cron', cron: '0 9 * * *', prompt: 'Report.' };
  test('shared default resolves without freezing an override on roundtrip', () => {
    const parsed = extractTriggers({ path: 'kortix.yaml', raw: { trigger_session_readers: policy, triggers: [trigger] } });
    expect(parsed.errors).toEqual([]);
    expect(parsed.specs[0]?.defaultSessionReaders).toEqual({ humans: 'members', agents: ['my-kortix', 'watchdog'] });
    const spec = parsed.specs[0];
    if (!spec) throw new Error('trigger did not parse');
    expect(triggerSpecToFlatEntry(spec)).not.toHaveProperty('session_readers');
    expect(triggerSpecToOnRunEntry(spec)).not.toHaveProperty('session_readers');
  });
  test('explicit none overrides the shared default and survives both formats', () => {
    const explicit: TriggerReaders = { humans: 'none', agents: [] };
    const parsed = extractTriggers({ path: 'kortix.yaml', raw: { trigger_session_readers: policy, triggers: [{ ...trigger, session_readers: explicit }] } });
    expect(parsed.specs[0]?.sessionReaders).toEqual(explicit);
    const spec = parsed.specs[0];
    if (!spec) throw new Error('trigger did not parse');
    expect(triggerSpecToFlatEntry(spec)).toHaveProperty('session_readers', explicit);
    expect(triggerSpecToOnRunEntry(spec)).toHaveProperty('session_readers', explicit);
  });
  test('unconfigured projects keep no additive reader standing', () => {
    const parsed = extractTriggers({ path: 'kortix.yaml', raw: { triggers: [trigger] } });
    expect(parsed.specs[0]).not.toHaveProperty('sessionReaders');
    expect(parsed.specs[0]).not.toHaveProperty('defaultSessionReaders');
  });
  test('validator accepts the declaration and rejects wildcard agent scope', () => {
    const base = 'trigger_session_readers:\n  humans: members\n  agents: [watchdog]\nagents:\n  watchdog:\n    prompt: Observe.\n    tools: none\n';
    expect(validateManifest(base).valid).toBe(true);
    expect(validateManifest(base.replace('[watchdog]', '["*"]')).valid).toBe(false);
  });
});
