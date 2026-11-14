/**
 * `useCachedWorkspaceSessions`: the rows of a few sessions, read from the
 * session caches other hooks already fill. A host (the desktop tab strip) shows
 * a session's title and status without its own request, in step with the
 * sidebar. The hook must re-render only when one of ITS rows changes: the
 * query cache fires on every stream write in the app.
 */
import { expect, test } from 'bun:test';
import React from 'react';
import { act, create } from 'react-test-renderer';

import type { ProjectSession } from '../core/rest/projects-client/sessions';
import { qk } from './query-keys';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { useCachedWorkspaceSessions } = await import('./use-cached-workspace-sessions');

const P = 'P1';
const row = (id: string, name: string) =>
  ({ session_id: id, custom_name: name }) as unknown as ProjectSession;

test('re-renders when a watched row changes, and not for unrelated cache writes', async () => {
  const qc = new QueryClient();
  const seen: ReadonlyMap<string, ProjectSession>[] = [];
  function Probe() {
    seen.push(useCachedWorkspaceSessions(P, ['S1']));
    return null;
  }
  await act(async () => {
    create(
      React.createElement(QueryClientProvider, { client: qc }, React.createElement(Probe)),
    );
  });
  expect(seen.at(-1)?.size).toBe(0);

  const first = row('S1', 'first');
  await act(async () => {
    qc.setQueryData(qk.project.sessions(P, 'visible'), [first]);
  });
  expect(seen.at(-1)?.get('S1')?.custom_name).toBe('first');
  const renders = seen.length;

  // Another session, another project, a message cache: none is a watched row.
  await act(async () => {
    qc.setQueryData(qk.project.sessions(P, 'project'), [first, row('S2', 'x')]);
    qc.setQueryData(qk.project.sessions('P2', 'visible'), [row('S1', 'other project')]);
    qc.setQueryData(['unrelated'], 1);
  });
  expect(seen.length).toBe(renders);

  await act(async () => {
    qc.setQueryData(qk.project.sessions(P, 'visible'), [row('S1', 'renamed')]);
  });
  expect(seen.at(-1)?.get('S1')?.custom_name).toBe('renamed');
});
