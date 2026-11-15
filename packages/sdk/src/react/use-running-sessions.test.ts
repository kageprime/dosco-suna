import { describe, expect, mock, test } from 'bun:test';

// `useQuery` returns its config, so the wiring is asserted without a render tree.
const calls: Array<{ projectId: string; options: unknown }> = [];
let served: unknown[] = [{ session_id: 's1', working: { state: 'working' } }];
mock.module('@tanstack/react-query', () => ({
  useQuery: (config: Record<string, unknown>) => config,
}));
mock.module('../core/rest/projects-client', () => ({
  listWorkspaceSessionsPage: async (projectId: string, options: unknown) => {
    calls.push({ projectId, options });
    return { items: served, next_cursor: null };
  },
}));

const { useRunningSessions, RUNNING_SESSIONS_LIMIT } = await import('./use-running-sessions');
const { qk } = await import('./query-keys');

const interval = (hook: any, data?: unknown) => hook.refetchInterval({ state: { data } });

describe('useRunningSessions', () => {
  test('reads the working sessions of the workspace, one page', async () => {
    const hook = useRunningSessions('p1') as any;
    expect(await hook.queryFn()).toEqual([{ session_id: 's1', working: { state: 'working' } }]);
    expect(calls.at(-1)).toEqual({ projectId: 'p1', options: { working: true, limit: RUNNING_SESSIONS_LIMIT } });
  });

  test('an API older than working=only lists every session: only the working ones are kept', async () => {
    served = [
      { session_id: 'busy', working: { state: 'working' } },
      { session_id: 'idle', working: { state: 'idle' } },
      { session_id: 'none' },
    ];
    const hook = useRunningSessions('p1') as any;
    expect((await hook.queryFn()).map((s: { session_id: string }) => s.session_id)).toEqual(['busy']);
    served = [{ session_id: 's1', working: { state: 'working' } }];
  });

  test('its key nests under the sessions scope, so every session invalidation refreshes it', () => {
    const key = (useRunningSessions('p1') as any).queryKey;
    expect(key).toEqual([...qk.project.runningSessions('p1')]);
    const scope = qk.project.sessionsScope('p1');
    expect(key.slice(0, scope.length)).toEqual([...scope]);
    // Two segments past the scope: never the key of one session (`session(id, sid)` is one).
    expect(key.length).toBe(qk.project.session('p1', 'x').length + 1);
  });

  test('disabled without a workspace or when the caller turns it off', () => {
    expect((useRunningSessions(null) as any).enabled).toBe(false);
    expect((useRunningSessions('p1', { enabled: false }) as any).enabled).toBe(false);
    expect((useRunningSessions('p1') as any).enabled).toBe(true);
  });

  test('polls fast while the list is open, modestly while work runs, slowly while nothing runs', () => {
    expect(interval(useRunningSessions('p1', { open: true }), [])).toBe(5_000);
    expect(interval(useRunningSessions('p1'), [{ session_id: 's1' }])).toBe(15_000);
    expect(interval(useRunningSessions('p1'), [])).toBe(20_000);
    expect(interval(useRunningSessions('p1'), undefined)).toBe(20_000);
    expect((useRunningSessions('p1') as any).refetchIntervalInBackground).toBe(false);
  });
});
