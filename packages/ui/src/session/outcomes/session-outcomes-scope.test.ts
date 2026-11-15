import { describe, expect, test } from 'bun:test';

import { changeRequestKeys } from '../../files/index';

/**
 * A session's outcome cards poll change requests every 60 s per open thread.
 * They read ONE session's list, filtered by the server, and that entry must
 * still be reached by the invalidations the change-request dialog issues —
 * otherwise a card keeps saying "Waiting for you" after a merge.
 */
describe('session outcomes read a server-scoped, invalidatable list', () => {
  test('the session list nests under the project and list-scope prefixes', () => {
    const key = changeRequestKeys.sessionList('P1', 'S1');
    const project = changeRequestKeys.project('P1');
    const listScope = changeRequestKeys.listScope('P1');
    expect(key.slice(0, project.length)).toEqual([...project]);
    expect(key.slice(0, listScope.length)).toEqual([...listScope]);
  });
});

// Finding 15: every busy -> idle edge marked the whole project prefix stale, twice
// (now and +2.5 s): the sidebar's 36 KB change-request list was read 12-17 times a turn.
describe('a turn end re-reads only what the turn can change', () => {
  test('this session\'s list, the sidebar list and the review summary; not other sessions, other lists or details', async () => {
    const { QueryClient } = await import('@tanstack/react-query');
    const { qk } = await import('@kortix/sdk/react');
    const { invalidateTurnChangeRequestReads } = await import('../../files/project/hooks/use-change-requests');
    const qc = new QueryClient();
    const keys = {
      session: changeRequestKeys.sessionList('P1', 'S1'),
      sidebar: changeRequestKeys.sidebarRecent('P1'),
      summary: qk.project.reviewSummary('P1'),
      otherSession: changeRequestKeys.sessionList('P1', 'S2'),
      reviewList: changeRequestKeys.list('P1', 'open'),
      detail: changeRequestKeys.detail('P1', 'cr1'),
      diff: changeRequestKeys.diff('P1', 'cr1'),
    };
    for (const key of Object.values(keys)) qc.setQueryData(key, {});
    invalidateTurnChangeRequestReads(qc, 'P1', 'S1');
    const stale = Object.fromEntries(
      Object.entries(keys).map(([name, key]) => [name, qc.getQueryState(key)?.isInvalidated === true]),
    );
    expect(stale).toEqual({
      session: true,
      sidebar: true,
      summary: true,
      otherSession: false,
      reviewList: false,
      detail: false,
      diff: false,
    });
  });
});
