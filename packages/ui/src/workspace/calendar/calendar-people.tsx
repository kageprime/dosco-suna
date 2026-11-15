'use client';

// Who is on an item: the workspace's people and agents as the calendar shows
// them (avatar, name, @handle), from one directory read. Persons and agents
// are one list: `Participants` draws them as one stacked group everywhere
// (card, panel, dialog), `PeoplePicker` edits the list.
import type { CalendarAuthor, CalendarParticipant, CalendarPeople, CalendarPerson } from '@kortix/sdk';
import { useWorkspaceCalendarPeople } from '@kortix/sdk/react';
import { agentDisplayName } from '@kortix/shared';
import { CheckIcon, UsersThreeIcon } from '@phosphor-icons/react';
import { Fragment, useState, type ReactNode } from 'react';
import { useTranslations } from '../../i18n';
import { AgentMark } from '../../internal/components/agent-mark';
import { cn } from '../../lib/utils';
import { AvatarGroup, AvatarGroupCount } from '../../primitives/avatar';
import { Button } from '../../primitives/button';
import {
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandPopover,
  CommandPopoverContent,
  CommandPopoverTrigger,
} from '../../primitives/command';
import { UserAvatar } from '../../primitives/user-avatar';
import { useUiViewerId } from '../../providers/ui-provider';

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

/** Avatar tile edge per size, in px: `UserAvatar` xs is size-5 (18.4px), sm is size-6 (22px). The agent tile matches it. */
const AGENT_TILE = { xs: 18, sm: 22 } as const;

/** One participant's face: a person's avatar or an agent's mark, with a hover hint naming them. */
export function ParticipantMark({
  who,
  directory,
  size = 'xs',
  ring = false,
}: {
  who: CalendarParticipant | CalendarAuthor;
  directory: CalendarDirectory;
  size?: 'xs' | 'sm';
  ring?: boolean;
}) {
  const t = useTranslations('calendar');
  if (who.kind === 'agent') {
    return <AgentMark slug={who.agent} size={14} tile={AGENT_TILE[size]} label={agentDisplayName(who.agent)} className={cn(ring && 'ring-background relative ring-2')} />;
  }
  const person = directory.person(who.user_id);
  const name = personName(person, t('formerMember'));
  return (
    <UserAvatar email={person?.email ?? ''} name={person?.name ?? name} avatarUrl={person?.avatar_url} colorKey={who.user_id} size={size} hint={name} ring={ring} />
  );
}

/** Everyone on an item as one overlapping group: up to `max` faces, then "+N". Nothing when nobody is on it. */
export function Participants({
  people,
  directory,
  size = 'xs',
  max = 3,
}: {
  people: readonly CalendarParticipant[];
  directory: CalendarDirectory;
  size?: 'xs' | 'sm';
  max?: number;
}) {
  if (people.length === 0) return null;
  const shown = people.slice(0, max);
  const rest = people.length - shown.length;
  return (
    <AvatarGroup className="-space-x-1.5">
      {shown.map((who) => (
        <ParticipantMark key={who.kind === 'agent' ? `a:${who.agent}` : `u:${who.user_id}`} who={who} directory={directory} size={size} ring />
      ))}
      {rest > 0 ? (
        // The count chip takes the avatars' own size (the primitive sizes it for sm/lg groups only).
        <AvatarGroupCount className={cn('text-xs tabular-nums', size === 'xs' ? 'size-5' : 'size-6')}>+{rest}</AvatarGroupCount>
      ) : null}
    </AvatarGroup>
  );
}

/** The names of the people on an item: "Ana Lima, Kortix +2". */
export function participantNames(people: readonly CalendarParticipant[], directory: CalendarDirectory, unknown: string, max = 2): string {
  const names = people.map((who) => (who.kind === 'agent' ? agentDisplayName(who.agent) : personName(directory.person(who.user_id), unknown)));
  return names.length > max ? `${names.slice(0, max).join(', ')} +${names.length - max}` : names.join(', ');
}

const sameParticipant = (a: CalendarParticipant, b: CalendarParticipant) =>
  a.kind === 'person' ? b.kind === 'person' && a.user_id === b.user_id : b.kind === 'agent' && a.agent === b.agent;

/** A search field shows only once the list is longer than this. */
const SEARCH_FROM = 8;

/**
 * Who is on an item, as a chip: the stacked faces and names, or "People".
 * It opens one searchable list (the agent picker's `CommandPopover`): People,
 * then Agents. A row toggles that participant; the list stays open.
 */
export function PeoplePicker({
  value,
  directory,
  onChange,
}: {
  value: readonly CalendarParticipant[];
  directory: CalendarDirectory;
  onChange: (people: CalendarParticipant[]) => void;
}) {
  const t = useTranslations('calendar');
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const query = search.trim().toLowerCase();
  const matches = (text: string) => !query || text.toLowerCase().includes(query);
  const people = directory.people.filter((p) => matches(`${p.name ?? ''} ${p.email ?? ''} ${p.handle}`));
  const agents = directory.agents.filter((a) => matches(`${a} ${agentDisplayName(a)}`));
  const toggle = (who: CalendarParticipant) =>
    onChange(value.some((v) => sameParticipant(v, who)) ? value.filter((v) => !sameParticipant(v, who)) : [...value, who]);
  const row = (who: CalendarParticipant, label: string, key: string) => {
    const on = value.some((v) => sameParticipant(v, who));
    return (
      <CommandItem key={key} value={key} className="gap-2" onSelect={() => toggle(who)}>
        <ParticipantMark who={who} directory={directory} />
        <span className="text-foreground min-w-0 flex-1 truncate text-sm">{label}</span>
        {on ? <CheckIcon className="text-foreground size-4 shrink-0" aria-hidden /> : null}
      </CommandItem>
    );
  };
  return (
    <CommandPopover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setSearch('');
      }}
      modal={false}
    >
      <CommandPopoverTrigger>
        <Button type="button" variant="outline" size="xs" className={cn('max-w-full font-normal', value.length === 0 && 'text-muted-foreground')}>
          {value.length > 0 ? (
            <>
              <Participants people={value} directory={directory} />
              <span className="truncate">{participantNames(value, directory, t('formerMember'))}</span>
            </>
          ) : (
            <>
              <UsersThreeIcon className="size-3.5 shrink-0" aria-hidden />
              {t('people')}
            </>
          )}
        </Button>
      </CommandPopoverTrigger>
      <CommandPopoverContent side="bottom" align="start" className="w-[min(320px,calc(100vw-1.5rem))]">
        {/* Mounted either way: cmdk's arrow keys need its input (agent-selector.tsx). */}
        <div className={directory.people.length + directory.agents.length > SEARCH_FROM ? undefined : 'sr-only'}>
          <CommandInput compact placeholder={t('searchPeople')} value={search} onValueChange={setSearch} />
        </div>
        <CommandList className="max-h-80">
          {people.length > 0 ? (
            <CommandGroup heading={t('people')}>
              {people.map((p) => row({ kind: 'person', user_id: p.user_id }, personName(p, p.handle), `u:${p.user_id}`))}
            </CommandGroup>
          ) : null}
          {agents.length > 0 ? (
            <CommandGroup heading={t('agents')}>
              {agents.map((a) => row({ kind: 'agent', agent: a }, agentDisplayName(a), `a:${a}`))}
            </CommandGroup>
          ) : null}
        </CommandList>
      </CommandPopoverContent>
    </CommandPopover>
  );
}

/** A person or an agent as one line: avatar and name. */
export function Who({
  who,
  directory,
  unknown,
}: {
  who: CalendarParticipant | CalendarAuthor;
  directory: CalendarDirectory;
  /** The name of a person who left the workspace. */
  unknown: string;
}) {
  if (who.kind === 'agent') {
    const name = agentDisplayName(who.agent);
    return (
      <span className="inline-flex min-w-0 items-center gap-1.5">
        <AgentMark slug={who.agent} size={14} label={name} />
        <span className="truncate">{name}</span>
      </span>
    );
  }
  const person = directory.person(who.user_id);
  const name = personName(person, unknown);
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <UserAvatar email={person?.email ?? ''} name={person?.name ?? name} avatarUrl={person?.avatar_url} colorKey={who.user_id} size="xs" />
      <span className="truncate">{name}</span>
    </span>
  );
}

/** Every token a person can be @mentioned by: handle, email, email local part, name slug. */
function mentionTokensOf(people: CalendarPerson[]): Set<string> {
  const out = new Set<string>();
  for (const p of people) {
    out.add(p.handle.toLowerCase());
    if (p.email) {
      out.add(p.email.toLowerCase());
      out.add(p.email.split('@')[0]!.toLowerCase());
    }
  }
  return out;
}

/**
 * Text with each @mention of a known person marked, the way chat apps do: a
 * mention of the viewer in yellow, of anyone else in blue. Only people are
 * marked: they are who a mention notifies. Line breaks kept.
 */
export function MentionText({ text, directory }: { text: string; directory: CalendarDirectory }): ReactNode {
  const viewer = directory.person(useUiViewerId() ?? '');
  const mine = mentionTokensOf(viewer ? [viewer] : []);
  const known = mentionTokensOf(directory.people);
  const parts = text.split(/((?:^|(?<=[^\w@]))@[a-z0-9][a-z0-9._+-]{1,63}(?:@[a-z0-9.-]+[a-z0-9])?)/gi);
  return (
    <>
      {parts.map((part, i) => {
        const token = part.startsWith('@') ? part.slice(1).toLowerCase().replace(/[._+-]+$/, '') : null;
        return token && known.has(token) ? (
          <span key={i} className={cn('text-foreground rounded-sm px-0.5 font-medium', mine.has(token) ? 'bg-kortix-yellow/15' : 'bg-kortix-blue/15')}>
            {part}
          </span>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        );
      })}
    </>
  );
}
