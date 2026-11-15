import { describe, expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import type { UnifiedTrigger } from '@kortix/sdk';

// The runtime half of the Triggers page. A one-shot that already fired
// (`state: 'done'`) reads as finished: a "Done" label instead of a dead
// switch, the time it was set for, and "Run again" instead of "Run now".
// Paused and active rows keep their switch. Hooks are mocked by module.

const AT = '2026-10-31T20:10:00.000Z';

function row(id: string, state: UnifiedTrigger['state'], source: UnifiedTrigger['source']): UnifiedTrigger {
  return {
    id,
    origin: 'runtime',
    name: id,
    prompt: `prompt ${id}`,
    agent: 'default',
    state,
    source,
    target: { kind: 'agent', agent: 'default' },
    next_fire_at: null,
    last_fired_at: null,
    last_status: null,
    last_error: null,
  };
}

let rows: UnifiedTrigger[] = [];
const idle = { isPending: false, variables: undefined, mutate: () => {} };

const sdkReact = await import('@kortix/sdk/react');
mock.module('@kortix/sdk/react', () => ({
  ...sdkReact,
  useUnifiedTriggers: () => ({ data: { triggers: rows }, update: idle, run: idle, remove: idle }),
}));

const { RuntimeTriggers, oneShotText, sortRuntimeRows } = await import('./runtime-triggers');
const { TooltipProvider } = await import('../../primitives/tooltip');

function render(list: UnifiedTrigger[]) {
  rows = list;
  return renderToStaticMarkup(
    <TooltipProvider>
      <RuntimeTriggers projectId="p1" />
    </TooltipProvider>,
  );
}

/** The markup of the `<li>` for one trigger id. */
function rowHtml(html: string, id: string): string {
  const start = html.indexOf(`data-trigger-id="${id}"`);
  expect(start).toBeGreaterThan(-1);
  const end = html.indexOf('</li>', start);
  return html.slice(start, end);
}

describe('RuntimeTriggers — a fired one-shot reads as done', () => {
  const done = row('trigger.done', 'done', { type: 'schedule', at: AT });
  const paused = row('trigger.paused', 'paused', { type: 'schedule', every: '4h' });
  const active = row('trigger.active', 'active', { type: 'schedule', cron: '0 9 * * *' });

  test('a done row shows "Done", the one-shot time and "Run again", and no switch', () => {
    const html = rowHtml(render([done]), 'trigger.done');
    expect(html).toContain('>Done</span>');
    expect(html).toContain('>Once</span>');
    expect(html).toContain(`<time dateTime="${AT}">${oneShotText(done.source, 'en')}</time>`);
    expect(html).toContain('aria-label="Run again"');
    expect(html).not.toContain('aria-label="Run now"');
    expect(html).not.toContain('role="switch"');
  });

  test('a paused row keeps a switch named "Resume" and "Run now"', () => {
    const html = rowHtml(render([paused]), 'trigger.paused');
    expect(html).toMatch(/role="switch"[^>]*aria-label="Resume"|aria-label="Resume"[^>]*role="switch"/);
    expect(html).toContain('aria-label="Run now"');
    expect(html).not.toContain('>Done</span>');
  });

  test('an active row keeps a switch named "Pause"', () => {
    const html = rowHtml(render([active]), 'trigger.active');
    expect(html).toMatch(/role="switch"[^>]*aria-label="Pause"|aria-label="Pause"[^>]*role="switch"/);
  });

  test('done rows list after active and paused rows', () => {
    const html = render([done, paused, active]);
    const order = ['trigger.paused', 'trigger.active', 'trigger.done'].map((id) =>
      html.indexOf(`data-trigger-id="${id}"`),
    );
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });
});

describe('oneShotText', () => {
  test('formats `at` in the locale, with date and time', () => {
    expect(oneShotText({ type: 'schedule', at: AT }, 'en')).toBe(
      new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(AT)),
    );
  });

  test('is null for a recurring schedule, a non-schedule source and a bad date', () => {
    expect(oneShotText({ type: 'schedule', cron: '0 9 * * *', at: AT }, 'en')).toBeNull();
    expect(oneShotText({ type: 'webhook', at: AT }, 'en')).toBeNull();
    expect(oneShotText({ type: 'schedule', at: 'not a date' }, 'en')).toBeNull();
  });
});

describe('sortRuntimeRows', () => {
  test('keeps the order within each group', () => {
    const a = row('a', 'done', { type: 'schedule', at: AT });
    const b = row('b', 'active', { type: 'schedule', every: '1h' });
    const c = row('c', 'done', { type: 'schedule', at: AT });
    const d = row('d', 'paused', { type: 'schedule', every: '1h' });
    expect(sortRuntimeRows([a, b, c, d]).map((r) => r.id)).toEqual(['b', 'd', 'a', 'c']);
  });
});
