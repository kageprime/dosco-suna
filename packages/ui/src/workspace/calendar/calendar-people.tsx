'use client';

// Who is on an item: the workspace's people and agents as the calendar shows
// them (avatar, name, @handle), from one directory read.
import type { CalendarAssignee, CalendarAuthor, CalendarPeople, CalendarPerson } from '@kortix/sdk';
import { useWorkspaceCalendarPeople } from '@kortix/sdk/react';
import { agentDisplayName } from '@kortix/shared';
import { Fragment, type ReactNode } from 'react';
import { AgentMark } from '../../internal/components/agent-mark';
import { UserAvatar } from '../../primitives/user-avatar';

export interface CalendarDirectory {
  people: CalendarPerson[];
  agents: string[];
  person(userId: string): CalendarPerson | undefined;
}

export function useCalendarDirectory(projectId: string): CalendarDirectory {
  const query = useWorkspaceCalendarPeople(projectId);
  return directoryOf(query.data);
}

export function directoryOf(data: CalendarPeople | undefined): CalendarDirectory {
  const people = data?.people ?? [];
  const byId = new Map(people.map((p) => [p.user_id, p]));
  return { people, agents: (data?.agents ?? []).map((a) => a.name), person: (id) => byId.get(id) };
}

export function personName(person: CalendarPerson | undefined, fallback: string): string {
  return person?.name?.trim() || person?.email?.split('@')[0] || fallback;
}

/** A person or an agent as one line: avatar and name. */
export function Who({
  who,
  directory,
  size = 'xs',
  nameless = false,
  unknown,
}: {
  who: CalendarAssignee | CalendarAuthor;
  directory: CalendarDirectory;
  size?: 'xs' | 'sm';
  /** The avatar only; the name goes in the hover hint. */
  nameless?: boolean;
  /** The name of a person who left the workspace. */
  unknown: string;
}) {
  if (who.kind === 'agent') {
    const name = agentDisplayName(who.agent);
    return (
      <span className="inline-flex min-w-0 items-center gap-1.5">
        <AgentMark slug={who.agent} size={size === 'xs' ? 14 : 21} label={name} />
        {nameless ? null : <span className="truncate">{name}</span>}
      </span>
    );
  }
  const person = directory.person(who.user_id);
  const name = personName(person, unknown);
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <UserAvatar
        email={person?.email ?? ''}
        name={person?.name ?? name}
        avatarUrl={person?.avatar_url}
        colorKey={who.user_id}
        size={size}
        hint={nameless ? name : undefined}
      />
      {nameless ? null : <span className="truncate">{name}</span>}
    </span>
  );
}

/** Every token a person can be @mentioned by: handle, email, email local part, name slug. */
function mentionTokensOf(directory: CalendarDirectory): Set<string> {
  const out = new Set<string>();
  for (const p of directory.people) {
    out.add(p.handle.toLowerCase());
    if (p.email) {
      out.add(p.email.toLowerCase());
      out.add(p.email.split('@')[0]!.toLowerCase());
    }
  }
  return out;
}

/** Text with each @mention of a known person set in medium weight. Line breaks kept. */
export function MentionText({ text, directory }: { text: string; directory: CalendarDirectory }): ReactNode {
  const known = mentionTokensOf(directory);
  const parts = text.split(/((?:^|(?<=[^\w@]))@[a-z0-9][a-z0-9._+-]{1,63}(?:@[a-z0-9.-]+[a-z0-9])?)/gi);
  return (
    <>
      {parts.map((part, i) => {
        const token = part.startsWith('@') ? part.slice(1).toLowerCase().replace(/[._+-]+$/, '') : null;
        return token && known.has(token) ? (
          <span key={i} className="text-foreground font-medium">
            {part}
          </span>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        );
      })}
    </>
  );
}
