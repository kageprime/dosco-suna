import { describe, expect, test } from 'bun:test';
import Ajv from 'ajv/dist/2020';
import { validateManifest } from './index';
import { KORTIX_JSON_SCHEMA } from './json-schema';
import { parseTriggerReaders } from './trigger-readers';

const schema = new Ajv({ strict: false, allErrors: true }).compile(KORTIX_JSON_SCHEMA);
const base = { agents: { observer: { prompt: 'Observe.', tools: 'none' } } };

describe('declarative trigger readers', () => {
  test('default and per-trigger policies agree between validators', () => {
    for (const policy of [
      { humans: 'members', agents: ['observer'] },
      { humans: 'none' },
      {},
      { humans: 'everyone' },
      { agents: ['*'] },
      { agents: ['observer'], start: true },
      { humans: null },
      { agents: null },
    ]) {
      const parsed = parseTriggerReaders(policy);
      const valid = !('error' in parsed);
      const manifest = { ...base, trigger_session_readers: policy };
      expect(validateManifest(manifest).valid).toBe(valid);
      expect(schema(manifest)).toBe(valid);
      const perTrigger = { ...base, triggers: [{ slug: 'daily', on: { cron: '0 9 * * *' }, run: { agent: 'observer', prompt: 'Observe.' }, session_readers: policy }] };
      expect(validateManifest(perTrigger).valid).toBe(valid);
      expect(schema(perTrigger)).toBe(valid);
    }
  });
  test('named scopes normalize without wildcards or duplicate identities', () => {
    expect(parseTriggerReaders({ humans: 'members', agents: ['z', 'a', 'a'] })).toEqual({ readers: { humans: 'members', agents: ['a', 'z'] } });
    expect(parseTriggerReaders({ agents: [''] })).toHaveProperty('error');
    expect(parseTriggerReaders({ agents: ['not a slug'] })).toHaveProperty('error');
  });
});
