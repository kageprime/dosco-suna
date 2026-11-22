'use client';

import type { ReactNode } from 'react';

import { cn } from '../lib/utils';
import { HoverCard, HoverCardContent, HoverCardTrigger } from './hover-card';
import { UserAvatar } from './user-avatar';

/** A person as every Kortix list knows them: an id, and whatever profile the API has. */
export interface ProfilePerson {
  userId: string;
  /** Display name from their profile; null or absent when they set none. */
  name?: string | null;
  email?: string | null;
  avatarUrl?: string | null;
}

/** The best label for a person: their name, else their email, else `fallback`. */
export function profileLabel(person: ProfilePerson, fallback = 'Unknown'): string {
  return person.name?.trim() || person.email?.trim() || fallback;
}

/**
 * Hover a person, see who they are: their picture, name and email, plus an
 * optional `detail` line the host owns (a role, "Created this space").
 *
 * The trigger is the host's own markup (`children`), so a row, an avatar or a
 * name can open it. Keyboard focus opens it too. The card is not animated:
 * it opens into the path the pointer already travels (hover-card.tsx).
 */
export function ProfileHoverCard({
  person,
  detail,
  children,
  side = 'left',
  align = 'start',
  className,
}: {
  person: ProfilePerson;
  /** One short line under the profile, such as "Created this space". */
  detail?: ReactNode;
  children: ReactNode;
  side?: 'top' | 'right' | 'bottom' | 'left';
  align?: 'start' | 'center' | 'end';
  className?: string;
}) {
  const label = profileLabel(person);
  const email = person.email?.trim() || null;
  return (
    <HoverCard openDelay={300} closeDelay={100}>
      <HoverCardTrigger asChild>{children}</HoverCardTrigger>
      <HoverCardContent side={side} align={align} sideOffset={8} animated={false} className={cn('w-64 p-3', className)}>
        {/* The picture is exactly as tall as the two lines beside it (size-9 = 17.5 + 15 px of tight leading, rounded up). */}
        <div className="flex min-w-0 items-center gap-2.5">
          <UserAvatar
            email={email ?? ''}
            name={person.name ?? email ?? label}
            avatarUrl={person.avatarUrl}
            colorKey={person.userId}
            size="lg"
            className="size-9"
          />
          <div className="min-w-0 flex-1">
            <p className="text-foreground truncate text-sm leading-tight font-medium">{label}</p>
            {email && email !== label ? <p className="text-muted-foreground truncate text-xs leading-tight">{email}</p> : null}
          </div>
        </div>
        {detail ? <div className="text-muted-foreground border-border mt-3 border-t pt-3 text-xs">{detail}</div> : null}
      </HoverCardContent>
    </HoverCard>
  );
}
