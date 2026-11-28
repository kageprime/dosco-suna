import { afterEach, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { useEffect } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { useSkippedConnectors } from './skipped-connectors';

const win = new Window({ url: 'http://localhost' });
Object.assign(globalThis, {
  window: win,
  document: win.document,
  Event: win.Event,
  IS_REACT_ACT_ENVIRONMENT: true,
});
let renderer: ReactTestRenderer | undefined;
let preference: ReturnType<typeof useSkippedConnectors>;
function Probe({ projectId }: { projectId: string }) {
  const current = useSkippedConnectors(projectId);
  useEffect(() => {
    preference = current;
  });
  return <span>{current.skipped.join(',')}</span>;
}
afterEach(async () => {
  await act(() => renderer?.unmount());
  win.localStorage.clear();
});

test('Skip persists across reload, is workspace scoped, and can be restored', async () => {
  await act(() => {
    renderer = create(<Probe projectId='synthetic-a' />);
  });
  await act(() => preference.skip('optional-calendar'));
  expect(preference.skipped).toEqual(['optional-calendar']);
  await act(() => preference.skip('optional-calendar'));
  expect(preference.skipped).toEqual(['optional-calendar']);
  await act(() => renderer?.unmount());
  await act(() => {
    renderer = create(<Probe projectId='synthetic-a' />);
  });
  expect(preference.skipped).toEqual(['optional-calendar']);
  await act(() => renderer?.update(<Probe projectId='synthetic-b' />));
  expect(preference.skipped).toEqual([]);
  await act(() => renderer?.update(<Probe projectId='synthetic-a' />));
  await act(() => preference.restore());
  expect(preference.skipped).toEqual([]);
});

test('invalid stored preference leaves setup available', async () => {
  win.localStorage.setItem(
    'kortix.setup.skippedConnectors.synthetic-a',
    '{broken',
  );
  await act(() => {
    renderer = create(<Probe projectId='synthetic-a' />);
  });
  expect(preference.skipped).toEqual([]);
});
