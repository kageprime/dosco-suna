'use client';

import type { ProjectSessionGroup } from '@kortix/sdk';
import { useFeatureFlag, useWorkspaceSessionGroups } from '@kortix/sdk/react';
import { CaretDownIcon, CheckIcon, PlusIcon, StackIcon } from '@phosphor-icons/react';
import { useState } from 'react';

import { useTranslations } from '../../i18n';
import { cn } from '../../lib/utils';
import { Button } from '../../primitives/button';
import {
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandPopover,
  CommandPopoverContent,
  CommandPopoverTrigger,
  CommandSeparator,
} from '../../primitives/command';
import { SpaceFormModal } from './space-form-modal';
import { SpaceIconBare } from './space-icon';

/** Spaces on screen before the popover shows its search field (it stays mounted for the arrow keys). */
const SEARCH_THRESHOLD = 8;

/**
 * The composer's Space chip (flag `session_groups`): the space a new session
 * is filed in. "No space" files it in none. "New space" creates one and picks
 * it. Renders nothing while the flag is off.
 */
export function SpacePicker({
  projectId,
  value,
  onChange,
}: {
  projectId: string;
  /** The picked space's id; null for no space. */
  value: string | null;
  onChange: (groupId: string | null) => void;
}) {
  const t = useTranslations('sessionSpaces');
  const enabled = useFeatureFlag(projectId, 'session_groups').enabled;
  const groups = useWorkspaceSessionGroups(enabled ? projectId : null);
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState('');
  if (!enabled) return null;

  const spaces = groups.data ?? [];
  const picked = value ? (spaces.find((space) => space.group_id === value) ?? null) : null;
  const query = search.trim().toLowerCase();
  const shown = query ? spaces.filter((space) => space.name.toLowerCase().includes(query)) : spaces;

  const pick = (groupId: string | null) => {
    onChange(groupId);
    setOpen(false);
    setSearch('');
  };

  const row = (space: ProjectSessionGroup) => (
    <CommandItem key={space.group_id} value={`space-${space.group_id}`} className="gap-2" onSelect={() => pick(space.group_id)}>
      {/* The space's icon and name as the sidebar's Spaces section draws them: the bare glyph, the name capitalised. */}
      <SpaceIconBare space={space} />
      <span className="min-w-0 flex-1 truncate first-letter:uppercase">{space.name}</span>
      {space.group_id === value ? <CheckIcon className="text-foreground size-4 shrink-0" /> : null}
    </CommandItem>
  );

  return (
    <>
      <CommandPopover open={open} onOpenChange={setOpen}>
        <CommandPopoverTrigger>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label={picked ? `${t('picker')}: ${picked.name}` : t('picker')}
            className={cn('rounded-lg hit-area-y-3', picked ? 'text-foreground' : 'text-muted-foreground')}
          >
            {picked ? <SpaceIconBare space={picked} /> : <StackIcon className="size-4 shrink-0" />}
            <span className="max-w-[140px] truncate first-letter:uppercase">{picked ? picked.name : t('picker')}</span>
            <CaretDownIcon className={cn('size-3 transition-transform duration-moderate ease-out', open && 'rotate-180')} />
          </Button>
        </CommandPopoverTrigger>
        <CommandPopoverContent side="top" align="start" sideOffset={8} className="w-[min(300px,calc(100vw-1.5rem))]">
          <div className={spaces.length > SEARCH_THRESHOLD ? undefined : 'sr-only'}>
            <CommandInput compact placeholder={t('pickerSearch')} value={search} onValueChange={setSearch} />
          </div>
          <CommandList className="max-h-[320px]">
            <CommandGroup forceMount className="[&_[cmdk-group-items]]:flex [&_[cmdk-group-items]]:flex-col [&_[cmdk-group-items]]:gap-px">
              {query ? null : (
                <CommandItem value="space-none" className="gap-2" onSelect={() => pick(null)}>
                  {/* The trigger's own "no space" glyph, so every row's name starts on one edge. */}
                  <StackIcon className="text-muted-foreground size-4 shrink-0" />
                  <span className="text-muted-foreground min-w-0 flex-1 truncate">{t('pickerNone')}</span>
                  {value === null ? <CheckIcon className="text-foreground size-4 shrink-0" /> : null}
                </CommandItem>
              )}
              {shown.map(row)}
              {query && shown.length === 0 ? (
                <div className="text-muted-foreground py-6 text-center text-xs">{t('pickerEmpty')}</div>
              ) : null}
              <CommandSeparator className="my-1" />
              <CommandItem
                value="space-new"
                className="gap-2"
                onSelect={() => {
                  setOpen(false);
                  setCreating(true);
                }}
              >
                <PlusIcon className="size-4 shrink-0" />
                <span className="min-w-0 flex-1 truncate">{t('newSpace')}</span>
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </CommandPopoverContent>
      </CommandPopover>
      <SpaceFormModal
        projectId={projectId}
        space={null}
        open={creating}
        onOpenChange={setCreating}
        onSaved={(space) => onChange(space.group_id)}
      />
    </>
  );
}
