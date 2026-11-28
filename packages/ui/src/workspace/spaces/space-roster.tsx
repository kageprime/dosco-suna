'use client';

import { useState } from 'react';

import { useTranslations } from '../../i18n';
import { AgentMark } from '../../internal/components/agent-mark';
import { AvatarGroup } from '../../primitives/avatar';
import { Button } from '../../primitives/button';
import { FadedScrollArea } from '../../primitives/faded-scroll-area';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '../../primitives/hover-card';
import { UserAvatar } from '../../primitives/user-avatar';
import { participantLabel } from '../../session/participants/session-participants';
import { PrincipalRow } from './principal-card';
import { agentLabel, type spaceRoster } from './space-timeline';

type Roster = ReturnType<typeof spaceRoster>;

/** Faces before the rest collapse into "+N": two people, three agents. */
const PEOPLE_SHOWN = 2;
const AGENTS_SHOWN = 3;

/**
 * Who is in the channel, in its header: its members' faces, a hairline, its
 * agents' tiles, each group's overflow as a quiet "+N". No frame: a hover fill
 * says it is a button. The same for every viewer (the channel's member list and
 * agent list, not the threads a viewer can load). People and agents never mix, so a glance tells them apart.
 * Hover, or a click, opens the session header's people card
 * (`SessionParticipantStack`): People, then Agents, each a label, a count and
 * rows that open each one's Profile. "View all members" opens Details at People.
 */
export function SpaceRosterButton({ projectId, roster, onViewAll }: { projectId: string; roster: Roster; onViewAll: () => void }) {
  const t = useTranslations('spaces.view');
  const [open, setOpen] = useState(false);
  const { people, agents } = roster;
  const morePeople = people.length - PEOPLE_SHOWN;
  const moreAgents = agents.length - AGENTS_SHOWN;
  const label = t('roster', {
    people: t('rosterPeople', { count: people.length }),
    agents: t('rosterAgents', { count: agents.length }),
  });

  return (
    <HoverCard open={open} onOpenChange={setOpen} openDelay={300} closeDelay={100}>
      <HoverCardTrigger asChild>
        <button
          type="button"
          aria-label={label}
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className="hover:bg-hover focus-visible:ring-ring data-[state=open]:bg-hover flex h-8 shrink-0 cursor-pointer items-center gap-2 rounded-md px-1.5 outline-none focus-visible:ring-2"
        >
          {people.length > 0 ? (
            <span className="flex items-center gap-1">
              <AvatarGroup className="-space-x-1">
                {people.slice(0, PEOPLE_SHOWN).map((person) => (
                  <UserAvatar
                    key={person.id}
                    email={person.email ?? ''}
                    name={participantLabel(person)}
                    avatarUrl={person.avatarUrl}
                    colorKey={person.id}
                    size="xs"
                    ring
                  />
                ))}
              </AvatarGroup>
              {/* The rest as quiet text beside the faces, never a chip laid over them. */}
              {morePeople > 0 ? <span className="text-muted-foreground text-xs tabular-nums">+{morePeople}</span> : null}
            </span>
          ) : null}
          {people.length > 0 && agents.length > 0 ? <span aria-hidden className="h-3.5 shrink-0 border-l" /> : null}
          {agents.length > 0 ? (
            <span className="flex items-center gap-1">
              <span className="flex -space-x-1">
                {agents.slice(0, AGENTS_SHOWN).map((agent) => (
                  // 18px tile beside the people's 18px (`xs`) faces.
                  <AgentMark key={agent} slug={agent} size={14} tile={18} className="ring-background ring-2" />
                ))}
              </span>
              {moreAgents > 0 ? <span className="text-muted-foreground text-xs tabular-nums">+{moreAgents}</span> : null}
            </span>
          ) : null}
        </button>
      </HoverCardTrigger>
      {/* The session header's card: a label and count per group, then rows in a
          capped scroll area. Not animated, like that card. */}
      <HoverCardContent
        side="bottom"
        align="end"
        sideOffset={6}
        animated={false}
        className="w-72 overflow-hidden p-0"
        onEscapeKeyDown={() => setOpen(false)}
      >
        {/* Tall enough for a full channel's first rows without the fade landing on the last one. */}
        <FadedScrollArea fadeColor="from-popover" fadeSize="6" className="max-h-96 overscroll-contain">
          {people.length > 0 ? (
            <RosterGroup title={t('rosterTitlePeople')} count={people.length}>
              {people.map((person) => (
                <PrincipalRow
                  key={person.id}
                  projectId={projectId}
                  principal={{ kind: 'person', userId: person.id, name: participantLabel(person), avatarUrl: person.avatarUrl }}
                  avatar={<UserAvatar email={person.email ?? ''} name={participantLabel(person)} avatarUrl={person.avatarUrl} colorKey={person.id} size="sm" />}
                  // The display name only: an email is not a name.
                  name={participantLabel(person)}
                  onOpened={() => setOpen(false)}
                />
              ))}
            </RosterGroup>
          ) : null}
          {agents.length > 0 ? (
            <RosterGroup title={t('rosterTitleAgents')} count={agents.length}>
              {agents.map((agent) => (
                <PrincipalRow
                  key={agent}
                  projectId={projectId}
                  principal={{ kind: 'agent', name: agent }}
                  // 22px, the people's `sm` faces: one avatar size down the whole card.
                  avatar={<AgentMark slug={agent} size={14} tile={22} />}
                  name={agentLabel(agent)}
                  secondary={t('agentThreads', { count: roster.agentThreads[agent] ?? 0 })}
                  onOpened={() => setOpen(false)}
                />
              ))}
            </RosterGroup>
          ) : null}
        </FadedScrollArea>
        <div className="border-t p-1">
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start font-normal"
            onClick={() => {
              setOpen(false);
              onViewAll();
            }}
          >
            {t('viewAllMembers')}
          </Button>
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}

/** "People 6", then the rows: the session card's header line, once per group. */
function RosterGroup({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  return (
    <section>
      <div className="text-muted-foreground flex items-center justify-between px-3.5 pt-2.5 pb-1 text-xs">
        <span>{title}</span>
        <span className="tabular-nums">{count}</span>
      </div>
      {/* Each row opens its person's or agent's Profile (`PrincipalRow`). */}
      <ul className="p-1 pt-0">{children}</ul>
    </section>
  );
}
