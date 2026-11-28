import { expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';

const replace = mock(() => {});
const router = { replace };
mock.module('next/navigation', () => ({ useRouter: () => router }));
const { ChangelogAnchorRedirect } = await import('./anchor-redirect');

test('release links navigate after the index mounts and stop listening after unmount', async () => {
  const win = new Window({ url: 'http://localhost:3000/changelog' });
  const keys = ['window', 'document', 'IS_REACT_ACT_ENVIRONMENT'];
  const saved = keys.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperties(globalThis, {
    window: { value: win, configurable: true },
    document: { value: win.document, configurable: true },
    IS_REACT_ACT_ENVIRONMENT: { value: true, configurable: true },
  });
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const tagPages = { 'v0.16.0': 1, 'v0.12.1': 3 };
  const changeHash = async (hash: string) => {
    win.history.replaceState(null, '', `/changelog${hash}`);
    const event = win.document.createEvent('Event');
    event.initEvent('hashchange', false, false);
    await act(async () => win.dispatchEvent(event));
  };
  try {
    replace.mockClear();
    await act(async () => root.render(<ChangelogAnchorRedirect page={0} tagPages={tagPages} />));
    expect(replace).not.toHaveBeenCalled();
    await changeHash('#v0.16.0');
    expect(replace).toHaveBeenLastCalledWith('/changelog/releases#v0.16.0');
    await changeHash('#v0.12.1');
    expect(replace).toHaveBeenLastCalledWith('/changelog/releases/page/3#v0.12.1');
    replace.mockClear();
    await changeHash('#%ZZ');
    await changeHash('#unknown');
    host.innerHTML = '<div id="v0.16.0"></div>';
    await changeHash('#v0.16.0');
    expect(replace).not.toHaveBeenCalled();
    await act(async () => root.unmount());
    await changeHash('#v0.12.1');
    expect(replace).not.toHaveBeenCalled();
  } finally {
    host.remove();
    await win.happyDOM.close();
    keys.forEach((key, index) => {
      const descriptor = saved[index];
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    });
  }
});
