import { expect, test } from 'bun:test';
import { extractTriggers, parseManifestString, triggerSpecToFlatEntry, triggerSpecToOnRunEntry } from '../projects/triggers';

test('disabled keyed worker retains its opt-in hard caps through both manifest forms', () => {
  const parsed = extractTriggers(parseManifestString(`project:\n  name: synthetic\ntriggers:\n  - slug: support-case\n    type: cron\n    cron: "0 * * * *"\n    enabled: false\n    agent: default\n    prompt: draft\n    session_key: '{{ body.thread_id }}'\n    hard_run_caps: true\n    max_runs_per_hour: 5\n    max_runs_per_day: 20\n`));
  expect(parsed.errors).toEqual([]);
  const spec = parsed.specs[0];
  expect(spec).toBeDefined();
  expect(spec).toMatchObject({ hardRunCaps: true, enabled: false, sessionMode: 'keyed' });
  if (!spec) throw new Error('Missing parsed trigger');
  expect(triggerSpecToFlatEntry(spec).hard_run_caps).toBe(true);
  expect(triggerSpecToOnRunEntry(spec).hard_run_caps).toBe(true);
});

test('hard caps reject non-boolean policy input', () => {
  const parsed = extractTriggers(parseManifestString(`project:\n  name: synthetic\ntriggers:\n  - slug: bad\n    type: cron\n    cron: "0 * * * *"\n    prompt: draft\n    hard_run_caps: yes\n`));
  expect(parsed.errors).toHaveLength(1);
  expect(parsed.specs).toHaveLength(0);
});
