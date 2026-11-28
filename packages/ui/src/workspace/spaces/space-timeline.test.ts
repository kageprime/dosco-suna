import { describe, expect, test } from 'bun:test';
import type { ProjectSession } from '@kortix/sdk';

import {
  buildSpaceTimeline,
  jumpTargetDate,
  markdownToPlainText,
  timelineEntries,
  messageMentionSegments,
  postSegments,
  rootPostAuthor,
  dayKind,
  gutterTime,
  lastReplyLabel,
  liveReplyCount,
  replyRole,
  spaceRoster,
  threadActivitySince,
  threadFiltersFromParams,
  threadIsWorking,
  threadMessageText,
  threadStatus,
} from './space-timeline';

/** Local wall-clock time, so the day grouping is the same in every time zone. */
const at = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute).toISOString();

function thread(id: string, createdBy: string, createdAt: string, extra: Partial<ProjectSession> = {}) {
  return {
    session_id: id,
    created_by: createdBy,
    created_at: createdAt,
    updated_at: createdAt,
    status: 'running',
    first_prompt: null,
    name: null,
    custom_name: null,
    branch_name: '',
    metadata: {},
    ...extra,
  } as unknown as ProjectSession;
}

describe('buildSpaceTimeline', () => {
  test('orders threads oldest first and groups them by local day', () => {
    const days = buildSpaceTimeline([
      thread('c', 'u1', at(20, 9)),
      thread('a', 'u1', at(19, 23, 50)),
      thread('b', 'u2', at(20, 0, 5)),
    ]);
    expect(days.map((day) => day.threads.map((item) => item.session_id))).toEqual([['a'], ['b', 'c']]);
    expect(days[1]!.date.getDate()).toBe(20);
  });
});

describe('liveReplyCount', () => {
  test('counts person messages after the first plus one per answered person message', () => {
    expect(liveReplyCount([])).toBe(0);
    expect(liveReplyCount(['user'])).toBe(0);
    // Several assistant steps answer one message: one reply.
    expect(liveReplyCount(['user', 'assistant', 'assistant'])).toBe(1);
    // A reply sent, not answered yet.
    expect(liveReplyCount(['user', 'assistant', 'user'])).toBe(2);
    expect(liveReplyCount(['user', 'assistant', 'user', 'assistant'])).toBe(3);
    // A steer before the answer: two people messages, one answer.
    expect(liveReplyCount(['user', 'user', 'assistant'])).toBe(2);
  });

  test('a platform notice is no reply, the answer to it is one', () => {
    // A router thread: "On it.", the worker's report, the relayed answer.
    expect(liveReplyCount(['user', 'assistant', 'notice', 'assistant'])).toBe(2);
    // A notice nobody answered yet.
    expect(liveReplyCount(['user', 'assistant', 'notice'])).toBe(1);
  });
});

describe('replyRole', () => {
  test('a worker report the platform delivered reads as a notice', () => {
    const report = [
      'A background subagent you started has finished. This message is from the platform, not from the user.',
      'task_id: 1294b06f-0000-0000-0000-000000000000',
      'status: completed',
      '',
      '<kortix_system type="session-report" source="subagent">',
      '<session-report>',
      '<session-id>1294b06f-0000-0000-0000-000000000000</session-id>',
      '<status>COMPLETE</status>',
      '<project>worker</project>',
      '<prompt>Poem</prompt>',
      '<result>\n<task_result>\nA poem.\n</task_result>\n</result>',
      '</session-report>',
      '</kortix_system>',
    ].join('\n');
    expect(replyRole('user', [{ type: 'text', text: report }])).toBe('notice');
    expect(replyRole('user', [{ type: 'text', text: 'Write a poem' }])).toBe('user');
    expect(replyRole('assistant', [{ type: 'text', text: report }])).toBe('assistant');
    expect(replyRole('user', undefined)).toBe('user');
  });
});

describe('dayKind', () => {
  const now = new Date(2026, 9, 20, 15, 0);
  test('names today, yesterday and older days', () => {
    expect(dayKind(new Date(2026, 9, 20, 0, 1), now)).toBe('today');
    expect(dayKind(new Date(2026, 9, 19, 23, 59), now)).toBe('yesterday');
    expect(dayKind(new Date(2026, 9, 18, 12, 0), now)).toBe('earlier');
  });
});

describe('lastReplyLabel', () => {
  test('reads the last activity relative to now', () => {
    const now = new Date(2026, 9, 20, 15, 0).getTime();
    expect(lastReplyLabel(thread('a', 'u1', at(20, 3), { updated_at: at(20, 3) }), 'en', now)).toBe('12 hours ago');
    expect(lastReplyLabel(thread('a', 'u1', at(20, 14, 58), { updated_at: at(20, 14, 58) }), 'en', now)).toBe(
      '2 minutes ago',
    );
  });
});

describe('threadIsWorking', () => {
  test('is true while a turn runs or the first prompt waits for delivery', () => {
    const idle = { state: 'idle', since: null, turn_token: null, pending_delivery: false } as const;
    expect(threadIsWorking(thread('a', 'u1', at(20, 1), { working: { ...idle, state: 'working' } }))).toBe(true);
    expect(threadIsWorking(thread('a', 'u1', at(20, 1), { working: { ...idle, pending_delivery: true } }))).toBe(true);
    expect(threadIsWorking(thread('a', 'u1', at(20, 1), { status: 'provisioning' }))).toBe(true);
    expect(threadIsWorking(thread('a', 'u1', at(20, 1), { working: idle }))).toBe(false);
  });
});

describe('threadMessageText', () => {
  test('shows the first prompt without its reference blocks', () => {
    const text = 'Summarise @notes.md\n\n<file_ref path="notes.md" name="notes.md" />';
    expect(threadMessageText(thread('a', 'u1', at(20, 1), { first_prompt: text }))).toBe('Summarise @notes.md');
  });

  test('falls back to the thread title when there is no first prompt', () => {
    expect(threadMessageText(thread('a', 'u1', at(20, 1), { name: 'Weekly report' }))).toBe('Weekly report');
  });
});

describe('gutterTime', () => {
  test('drops the day period so the time fits the avatar gutter', () => {
    const afternoon = new Date(2026, 9, 20, 14, 13);
    expect(gutterTime(afternoon, 'en')).toBe('2:13');
    expect(gutterTime(afternoon, 'de')).toBe('14:13');
    expect(gutterTime(afternoon, 'zh')).toMatch(/^1?[0-9]:13$/);
  });
});

describe('spaceRoster', () => {
  test('lists each person who started a thread once, and every agent that answered one', () => {
    const roster = spaceRoster([
      thread('a', 'u1', at(20, 9), { owner_type: 'user', owner_name: 'Ada', agent_name: 'kortix' }),
      thread('b', 'u1', at(20, 10), { owner_type: 'user', owner_name: 'Ada', agent_name: 'writer' }),
      thread('c', 'sa1', at(20, 11), { owner_type: 'service_account', agent_name: 'kortix' }),
      thread('d', 'u2', at(20, 12), { owner_type: 'user', owner_email: 'grace@example.test', agent_name: null }),
    ]);
    expect(roster.people.map((person) => person.id)).toEqual(['u1', 'u2']);
    expect(roster.agents).toEqual(['kortix', 'writer']);
    // How many loaded threads each started or answered: the Members row's count.
    expect(roster.people.map((person) => person.threads)).toEqual([2, 1]);
    expect(roster.agentThreads).toEqual({ kortix: 2, writer: 1 });
  });

  test("a DM counts its agent before any thread exists", () => {
    expect(spaceRoster([], 'writer')).toEqual({ people: [], agents: ['writer'], agentThreads: { writer: 0 } });
  });
});

describe('thread filters', () => {
  const params = (query: string) => new URLSearchParams(query);
  const USER = '0b6f3c1e-8a4d-4f2b-9c7e-1d2a3b4c5d6e';

  test('reads the URL; unknown values, a malformed person and a DM\'s person and agent are dropped', () => {
    expect(threadFiltersFromParams(params(`q=+lease+&status=failed&by=${USER}&agent=researcher&active=last7`), 'channel')).toEqual({
      q: 'lease',
      status: 'failed',
      by: USER,
      agent: 'researcher',
      active: 'last7',
    });
    expect(threadFiltersFromParams(params('status=bogus&by=alice&active=year'), 'channel')).toEqual({
      q: '',
      status: null,
      by: null,
      agent: null,
      active: null,
    });
    expect(threadFiltersFromParams(params('by=me&agent=researcher'), 'dm')).toMatchObject({ by: null, agent: null });
    expect(threadFiltersFromParams(params('by=me'), 'channel').by).toBe('me');
  });

  test('an Activity window starts at a local midnight: today, 6 or 29 days back', () => {
    const now = new Date(2026, 9, 25, 15, 30);
    expect(threadActivitySince('today', now)).toBe(new Date(2026, 9, 25).toISOString());
    expect(threadActivitySince('last7', now)).toBe(new Date(2026, 9, 19).toISOString());
    expect(threadActivitySince('last30', now)).toBe(new Date(2026, 8, 26).toISOString());
  });

  test('status: a review wins, then a running turn, then a failed computer, else done', () => {
    const working = thread('w', 'U', at(20, 9), { working: { state: 'working' } } as Partial<ProjectSession>);
    expect(threadStatus(working, 1)).toBe('needs-you');
    expect(threadStatus(working)).toBe('working');
    expect(threadStatus(thread('f', 'U', at(20, 9), { status: 'failed' }))).toBe('failed');
    expect(threadStatus(thread('d', 'U', at(20, 9), { status: 'stopped' }))).toBe('done');
    expect(threadStatus(thread('i', 'U', at(20, 9), { working: { state: 'idle' } } as Partial<ProjectSession>))).toBe('done');
  });
});

describe('a space post’s mentions', () => {
  const mentions = [
    { token: 'ana', kind: 'person', label: 'Ana Lima', userId: 'u-ana' },
    { token: 'researcher', kind: 'agent', label: 'researcher' },
  ];

  test('each resolved @token becomes a chip with the name and who it names; others stay text', () => {
    expect(postSegments('Done. @Ana, @researcher has the notes; mail me@example.test or @bob.', mentions)).toEqual([
      { text: 'Done. ' },
      { text: '@Ana', mention: { kind: 'person', label: 'Ana Lima', userId: 'u-ana' } },
      { text: ', ' },
      { text: '@researcher', mention: { kind: 'agent', label: 'researcher', agent: 'researcher' } },
      { text: ' has the notes; mail me@example.test or @bob.' },
    ]);
  });

  test('no mentions, or a malformed list: one plain run', () => {
    expect(postSegments('@ana hi', undefined)).toEqual([{ text: '@ana hi' }]);
    expect(postSegments('@ana hi', [{ token: 1 }])).toEqual([{ text: '@ana hi' }]);
  });

  test('the post’s author is the agent that wrote it, when one is stored', () => {
    expect(rootPostAuthor({ metadata: { chat_root_author: 'researcher' } } as never)).toBe('researcher');
    expect(rootPostAuthor({ metadata: {} } as never)).toBeNull();
  });
});

describe("a person's message mentions", () => {
  const candidates = [
    { token: 'ana@example.com', mention: { kind: 'person' as const, label: 'Ana Lima', userId: 'u-ana' } },
    { token: 'Ana Lima', mention: { kind: 'person' as const, label: 'Ana Lima', userId: 'u-ana' } },
    { token: 'worker', mention: { kind: 'agent' as const, label: 'Worker', agent: 'worker' } },
  ];

  test('email, a display name with a space, and an agent become chips; the longest token wins', () => {
    expect(messageMentionSegments('@Ana Lima and @worker, ping @ana@example.com', candidates)).toEqual([
      { text: '@Ana Lima', mention: { kind: 'person', label: 'Ana Lima', userId: 'u-ana' } },
      { text: ' and ' },
      { text: '@worker', mention: { kind: 'agent', label: 'Worker', agent: 'worker' } },
      { text: ', ping ' },
      { text: '@ana@example.com', mention: { kind: 'person', label: 'Ana Lima', userId: 'u-ana' } },
    ]);
  });

  test('no match inside a word or past a word boundary; no candidates: one run', () => {
    expect(messageMentionSegments('mail me@worker or @workers', candidates)).toEqual([{ text: 'mail me@worker or @workers' }]);
    expect(messageMentionSegments('@worker hi', [])).toEqual([{ text: '@worker hi' }]);
  });
});

describe('timelineEntries', () => {
  const thread = (id: string, created: string) => ({ session_id: id, created_at: created }) as ProjectSession;
  const join = (userId: string, at: string) => ({
    id: `member:${userId}`,
    kind: 'member_joined' as const,
    subject: { kind: 'person' as const, id: userId, name: `Member ${userId}` },
    actor: null,
    at,
  });

  test('a day holds its threads and its joins in time order', () => {
    const days = buildSpaceTimeline([thread('s1', '2026-11-20T10:00:00'), thread('s2', '2026-11-20T12:00:00')]);
    const groups = timelineEntries(days, [join('u1', '2026-11-20T11:00:00')], true);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.entries.map((entry) => (entry.kind === 'thread' ? entry.session.session_id : entry.join.subject.id))).toEqual(['s1', 'u1', 's2']);
  });

  test('a join on a day with no thread gets its own day', () => {
    const days = buildSpaceTimeline([thread('s1', '2026-11-20T10:00:00')]);
    const groups = timelineEntries(days, [join('u1', '2026-11-22T09:00:00')], true);
    expect(groups.map((group) => group.entries.length)).toEqual([1, 1]);
  });

  test('while older threads remain to load, a join older than the oldest loaded thread waits', () => {
    const days = buildSpaceTimeline([thread('s1', '2026-11-20T10:00:00')]);
    expect(timelineEntries(days, [join('u1', '2026-11-01T09:00:00')], false).flatMap((group) => group.entries)).toHaveLength(1);
    expect(timelineEntries(days, [join('u1', '2026-11-01T09:00:00')], true).flatMap((group) => group.entries)).toHaveLength(2);
  });
});

describe('jumpTargetDate', () => {
  const now = new Date(2026, 10, 26, 15, 30);
  test('each target is a local midnight', () => {
    expect(jumpTargetDate('today', now)).toEqual(new Date(2026, 10, 26));
    expect(jumpTargetDate('yesterday', now)).toEqual(new Date(2026, 10, 25));
    expect(jumpTargetDate('week', now)).toEqual(new Date(2026, 10, 19));
    expect(jumpTargetDate('month', now)).toEqual(new Date(2026, 9, 26));
  });
});

describe('markdownToPlainText', () => {
  test('keeps the words, drops the marks', () => {
    expect(markdownToPlainText('# Plan\n**Ship** the [rail](https://example.com) with `pins` and _care_.\n> quoted')).toBe(
      'Plan\nShip the rail with pins and care.\nquoted',
    );
  });
});
