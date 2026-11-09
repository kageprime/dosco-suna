import { afterEach, expect, jest, mock, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { type Root, createRoot } from 'react-dom/client';
import { type RecoverySession, useRuntimeRecovery } from '../src/use-runtime-recovery';

const window = new Window();
Object.defineProperties(globalThis, {
  window: { value: window, configurable: true },
  document: { value: window.document, configurable: true },
  navigator: { value: window.navigator, configurable: true },
  getComputedStyle: { value: window.getComputedStyle.bind(window), configurable: true },
  requestAnimationFrame: { value: window.requestAnimationFrame.bind(window), configurable: true },
  cancelAnimationFrame: { value: window.cancelAnimationFrame.bind(window), configurable: true },
  IS_REACT_ACT_ENVIRONMENT: { value: true, configurable: true },
});

const success = jest.fn();
const error = jest.fn();
mock.module('@kortix/ui/toast', () => ({ successToast: success, errorToast: error }));

let root: Root | undefined;

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  success.mockClear();
  error.mockClear();
});

const session = (over: Partial<RecoverySession> = {}): RecoverySession => ({
  projectId: 'p1',
  sessionId: 's1',
  runtimePhase: 'ready',
  switched: true,
  ...over,
});

/** Mounts the hook with a restart mock and a mutable session prop. */
function Harness({
  session,
  restart,
}: { session: RecoverySession; restart: () => Promise<unknown> }) {
  useRuntimeRecovery(session, { restart, sessionStartKey: ['session-start', 'p1', 's1'] });
  return null;
}

type Host = {
  rerender: (next: RecoverySession) => Promise<void>;
};

async function mountHarness(
  session: RecoverySession,
  restart: () => Promise<unknown>,
): Promise<Host> {
  const host = document.createElement('div');
  document.body.append(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  root = createRoot(host);
  const render = (next: RecoverySession) =>
    act(async () =>
      root?.render(
        <QueryClientProvider client={qc}>
          <Harness session={next} restart={restart} />
        </QueryClientProvider>,
      ),
    );
  await render(session);
  return { rerender: render };
}

test('an unreachable runtime that was switched restarts exactly once while it stays down', async () => {
  const restart = jest.fn(async () => {});
  const host = await mountHarness(session({ runtimePhase: 'unreachable' }), restart);
  expect(restart).toHaveBeenCalledTimes(1);
  expect(success).toHaveBeenCalledWith('Reconnecting the runtime…');
  // Re-renders while still down (polls, toasts) must not retry: one attempt
  // per down-episode is the guard's whole job.
  await host.rerender(session({ runtimePhase: 'unreachable' }));
  await host.rerender(session({ runtimePhase: 'unreachable' }));
  expect(restart).toHaveBeenCalledTimes(1);
});

test('the guard resets when the runtime comes back, so a later drop retries', async () => {
  const restart = jest.fn(async () => {});
  const host = await mountHarness(session({ runtimePhase: 'unreachable' }), restart);
  expect(restart).toHaveBeenCalledTimes(1);
  await host.rerender(session({ runtimePhase: 'ready' }));
  await host.rerender(session({ runtimePhase: 'unreachable' }));
  expect(restart).toHaveBeenCalledTimes(2);
});

test('a runtime that never connected (the initial boot) does not auto-restart', async () => {
  const restart = jest.fn(async () => {});
  await mountHarness(session({ switched: false, runtimePhase: 'unreachable' }), restart);
  expect(restart).not.toHaveBeenCalled();
});
