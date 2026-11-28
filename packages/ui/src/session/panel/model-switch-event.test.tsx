import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ModelSwitchEvent } from './model-switch-event';

test('model switch timeline names both models, author and continuation', () => {
  const html = renderToStaticMarkup(
    <ModelSwitchEvent
      summary={{
        from: 'old/model',
        to: 'new/model',
        actor_session_id: 'self',
        prompt: 'Finish the task',
      }}
    />,
  );
  for (const text of ['old/model', 'new/model', 'self', 'Finish the task'])
    expect(html).toContain(text);
});
test('unrelated or malformed events do not claim a model switch', () => {
  expect(renderToStaticMarkup(<ModelSwitchEvent summary={null} />)).toBe('');
  expect(renderToStaticMarkup(<ModelSwitchEvent summary={{ to: 42 }} />)).toBe(
    '',
  );
});

test('persisted history renders for an ordinary viewer without audit access', async () => {
  const { ModelSwitchHistory } = await import('./model-switch-event');
  const html = renderToStaticMarkup(
    <ModelSwitchHistory
      history={[
        {
          id: 'switch-1',
          from: 'old',
          to: 'new',
          prompt: 'Continue',
          actor_session_id: 'caller',
          at: '2026-11-04T00:00:00Z',
        },
      ]}
    />,
  );
  expect(html).toContain('Model switches');
  expect(html).toContain('Continue');
  expect(html).toContain('2026-11-04T00:00:00Z');
});

test('history starts collapsed and keeps every transition behind one labelled disclosure', async () => {
  const { ModelSwitchHistory } = await import('./model-switch-event');
  const history = Array.from({ length: 6 }, (_, index) => ({
    id: `switch-${index}`,
    from: index % 2 ? 'same/model' : `provider/source-${index}`,
    to: index % 2 ? 'same/model' : `provider/destination-${index}`,
    at: `2026-11-04T00:00:0${index}Z`,
  }));
  const html = renderToStaticMarkup(
    <ModelSwitchHistory history={history} current="provider/current" />,
  );
  const { Window } = await import('happy-dom');
  const document = new Window().document;
  document.body.innerHTML = html;
  const details = document.querySelector('details');
  expect(details).not.toBeNull();
  expect(details?.hasAttribute('open')).toBe(false);
  expect(details?.querySelector('summary')?.textContent).toContain(
    'Model switches',
  );
  expect(document.querySelectorAll('li').length).toBe(6);
  expect(
    Array.from(document.querySelectorAll('time')).map((time) => time.dateTime),
  ).toEqual(history.map((item) => item.at));
  expect(document.querySelector('summary')?.textContent).not.toContain('Human');
  expect(document.querySelector('summary')?.textContent).not.toContain('2026-');
});

test('empty and malformed histories draw neither a model line nor an empty disclosure', async () => {
  const { ModelSwitchHistory } = await import('./model-switch-event');
  for (const history of [
    undefined,
    [],
    [null, {}, { id: 'invalid', to: 42 }],
  ]) {
    expect(
      renderToStaticMarkup(
        <ModelSwitchHistory history={history} current="provider/model" />,
      ),
    ).toBe('');
  }
});

test('single transition has one usable disclosure and retains the full identifiers', async () => {
  const { ModelSwitchHistory } = await import('./model-switch-event');
  const longModel = `provider/${'long-model-name-'.repeat(20)}`;
  const html = renderToStaticMarkup(
    <ModelSwitchHistory
      history={[
        {
          id: 'single',
          from: 'source/model',
          to: longModel,
          actor_session_id: 'synthetic-agent',
          at: '2026-11-04T00:00:00Z',
        },
      ]}
      current={longModel}
    />,
  );
  const { Window } = await import('happy-dom');
  const document = new Window().document;
  document.body.innerHTML = html;
  expect(document.querySelectorAll('summary').length).toBe(1);
  expect(document.querySelector('summary')?.textContent).toContain(
    'Model switches · 1',
  );
  expect(document.querySelector('[title]')?.getAttribute('title')).toBe(
    longModel,
  );
  expect(document.querySelector('li')?.textContent).toContain(longModel);
  expect(document.querySelector('li')?.textContent).toContain(
    'synthetic-agent',
  );
});
