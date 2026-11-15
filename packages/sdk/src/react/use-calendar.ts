'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  addWorkspaceCalendarComment,
  createWorkspaceCalendarItem,
  deleteWorkspaceCalendarItem,
  getWorkspaceCalendarItem,
  listWorkspaceCalendarItems,
  listWorkspaceCalendarPeople,
  updateWorkspaceCalendarItem,
  type CalendarListQuery,
  type CreateCalendarItemInput,
  type UpdateCalendarItemInput,
} from '../core/rest/projects-client';
import { contract } from './query-contracts';
import { qk } from './query-keys';

const inventory = contract('inventory');
const config = contract('config');

/** People and agents write items from other tabs and sessions: a mounted calendar re-reads while the tab is visible. */
const calendarRefetch = (everyMs: number) => ({
  refetchInterval: <T>(query: T) => {
    const heal = typeof inventory.refetchInterval === 'function' ? inventory.refetchInterval(query as never) : false;
    return heal || everyMs;
  },
  refetchIntervalInBackground: false,
});

const queryKeyOf = (query: CalendarListQuery) =>
  JSON.stringify([query.from ?? '', query.to ?? '', query.with ?? '', query.status ?? '', query.undated === false ? 0 : 1]);

/**
 * The calendar items of one window and filter
 * (`GET /workspaces/:id/calendar`). Pass `null` while the `calendar` flag is
 * off: nothing loads. A mounted list re-reads every `refetchMs` (default 20
 * seconds) while the tab is visible.
 */
export function useWorkspaceCalendarItems(
  projectId: string | null | undefined,
  query: CalendarListQuery = {},
  options: { refetchMs?: number } = {},
) {
  return useQuery({
    queryKey: qk.project.calendarItems(projectId ?? '', queryKeyOf(query)),
    queryFn: () => listWorkspaceCalendarItems(projectId as string, query),
    enabled: !!projectId,
    placeholderData: (previous) => previous,
    ...inventory,
    ...calendarRefetch(options.refetchMs ?? 20_000),
  });
}

/** One calendar item and its comments. The error is an `ApiError` (404: the item is gone). */
export function useWorkspaceCalendarItem(projectId: string | null | undefined, itemId: string | null | undefined) {
  return useQuery({
    queryKey: qk.project.calendarItem(projectId ?? '', itemId ?? ''),
    queryFn: () => getWorkspaceCalendarItem(projectId as string, itemId as string),
    enabled: !!projectId && !!itemId,
    ...inventory,
    ...calendarRefetch(20_000),
  });
}

/** Who can be assigned or mentioned, with each person's `@handle`, and the agents. */
export function useWorkspaceCalendarPeople(projectId: string | null | undefined) {
  return useQuery({
    queryKey: qk.project.calendarPeople(projectId ?? ''),
    queryFn: () => listWorkspaceCalendarPeople(projectId as string),
    enabled: !!projectId,
    ...config,
  });
}

/** Create, change, delete and comment. Each one refreshes every calendar query of the workspace. */
export function useWorkspaceCalendarActions(projectId: string | null | undefined) {
  const client = useQueryClient();
  const pid = () => {
    if (!projectId) throw new Error('No workspace');
    return projectId;
  };
  const refresh = () => client.invalidateQueries({ queryKey: qk.project.calendar(projectId ?? '') });
  return {
    create: useMutation({ mutationFn: (input: CreateCalendarItemInput) => createWorkspaceCalendarItem(pid(), input), onSuccess: refresh }),
    update: useMutation({
      mutationFn: (args: { itemId: string; input: UpdateCalendarItemInput }) => updateWorkspaceCalendarItem(pid(), args.itemId, args.input),
      onSuccess: refresh,
    }),
    remove: useMutation({ mutationFn: (itemId: string) => deleteWorkspaceCalendarItem(pid(), itemId), onSuccess: refresh }),
    comment: useMutation({
      mutationFn: (args: { itemId: string; body: string }) => addWorkspaceCalendarComment(pid(), args.itemId, args.body),
      onSuccess: refresh,
    }),
  };
}
