import { describe, expect, test } from 'bun:test';
import { renderPromptTemplate, renderTriggerInput, triggerInputPreamble } from './trigger-payload';

describe('renderPromptTemplate', () => {
  test('a root token renders its value; an object renders as JSON', () => {
    expect(renderPromptTemplate('PR {{ change_request.number }}: {{ trigger }}', { change_request: { number: 7 }, trigger: { slug: 'x' } })).toBe('PR 7: {"slug":"x"}');
  });

  test('{{ payload }} renders the whole payload as JSON: a program agent reads it from stdin', () => {
    const payload = { trigger: { slug: 'hook', type: 'webhook' }, body: { id: 3 }, fired_at: '2026-11-13T00:00:00.000Z' };
    expect(JSON.parse(renderPromptTemplate('{{ payload }}', payload))).toEqual(payload);
  });

  test('a payload with its own `payload` key keeps that value', () => {
    expect(renderPromptTemplate('{{ payload }}', { payload: 'own' })).toBe('own');
  });
});

describe('renderTriggerInput', () => {
  const payload = { trigger: { slug: 'nightly', type: 'cron' }, fired_at: 'T' };

  test('an omitted prompt is the payload itself, as JSON', () => {
    expect(JSON.parse(renderTriggerInput({ promptTemplate: '' }, payload))).toEqual(payload);
  });

  test('run.payload is merged under the fire payload: the fire wins a clash', () => {
    const input = renderTriggerInput({ promptTemplate: '', runPayload: { days: 30, trigger: { slug: 'spoof' } } }, payload);
    expect(JSON.parse(input)).toEqual({ days: 30, trigger: { slug: 'nightly', type: 'cron' }, fired_at: 'T' });
  });

  test('a prompt template reads the merged payload', () => {
    expect(renderTriggerInput({ promptTemplate: 'Sweep {{ days }} days for {{ trigger.slug }}', runPayload: { days: 7 } }, payload)).toBe('Sweep 7 days for nightly');
  });
});

describe('triggerInputPreamble', () => {
  test('a prompt keeps the third-party notice; a payload input gets none, so it stays valid JSON', () => {
    expect(triggerInputPreamble({ promptTemplate: 'Label {{ event.data.id }}' }, '[Connector event: x]\n')).toBe('[Connector event: x]\n');
    expect(triggerInputPreamble({ promptTemplate: '' }, '[Connector event: x]\n')).toBe('');
  });
});
