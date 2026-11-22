'use client';

import type { ProjectSessionGroup } from '@kortix/sdk';
import { useUpdateWorkspaceSessionGroup } from '@kortix/sdk/react';
import { suggestSpaceIcon } from '@kortix/shared';

import { useTranslations } from '../../i18n';
import { cn } from '../../internal/lib/utils';
import { EntityAvatar, type EntityAvatarSize } from '../../primitives/entity-avatar';
import { glyphFace } from '../../primitives/glyph-face';
import { glyphForeground, glyphStyle } from '../../primitives/glyph-tint';
import { errorToast } from '../../primitives/toast';
import { ProjectIconField, type ProjectIconValue } from '../projects/modal/project-icon-field';

type SpaceIconSource = Pick<ProjectSessionGroup, 'name' | 'icon'>;

/**
 * The icon a space shows: the one picked or given at create, else the one its
 * name suggests (`suggestSpaceIcon`, the same function the API runs on
 * create). Never null, so every space has a face.
 */
export function spaceIconValue(space: SpaceIconSource): Exclude<ProjectIconValue, null> {
  return space.icon ?? suggestSpaceIcon(space.name);
}

/**
 * A space's icon with no tile: the glyph in its colour, or the emoji, sized by
 * `className` (default `size-4`). For dense rows such as the sidebar, where a
 * filled tile reads heavier than the name beside it.
 */
export function SpaceIconBare({ space, className }: { space: SpaceIconSource; className?: string }) {
  const icon = spaceIconValue(space);
  if ('emoji' in icon) {
    return (
      <span aria-hidden className={cn('inline-flex size-4 shrink-0 items-center justify-center text-sm leading-none', className)}>
        {icon.emoji}
      </span>
    );
  }
  const Glyph = glyphFace(icon.glyph.name) ?? glyphFace(suggestSpaceIcon(space.name).glyph.name);
  if (!Glyph) return null;
  return (
    <Glyph
      aria-hidden
      weight="fill"
      style={glyphStyle(icon.glyph.color)}
      className={cn('size-4 shrink-0', glyphForeground(icon.glyph.color), className)}
    />
  );
}

/** A space's icon as a tile: the spaces list, the picker. */
export function SpaceIcon({
  space,
  size = 'sm',
  className,
}: {
  space: SpaceIconSource;
  size?: EntityAvatarSize;
  className?: string;
}) {
  const icon = spaceIconValue(space);
  return (
    <EntityAvatar
      label={space.name}
      emoji={'emoji' in icon ? icon.emoji : null}
      glyph={'glyph' in icon ? icon.glyph : null}
      size={size}
      className={cn('border-0', className)}
    />
  );
}

/**
 * The space page's icon: the workspace icon picker (Icons and Emojis). A pick
 * saves at once and the tile repaints from the pending value, so it never
 * flashes the old icon. The trash button puts back the icon the name suggests.
 */
export function SpaceIconButton({
  projectId,
  space,
  className,
}: {
  projectId: string;
  space: ProjectSessionGroup;
  className?: string;
}) {
  const t = useTranslations('sessionSpaces');
  const update = useUpdateWorkspaceSessionGroup(projectId);
  const pending = update.isPending && update.variables?.groupId === space.group_id ? update.variables.input : null;
  const stored = pending && pending.icon !== undefined ? pending.icon : space.icon;
  const save = (icon: ProjectSessionGroup['icon']) =>
    update.mutate(
      { groupId: space.group_id, input: { icon } },
      { onError: () => errorToast(t('iconSaveFailed')) },
    );

  return (
    <ProjectIconField
      value={spaceIconValue({ name: space.name, icon: stored })}
      onChange={(emoji) => save({ emoji })}
      onGlyphChange={(glyph) => save({ glyph })}
      onClear={stored ? () => save(null) : undefined}
      triggerClassName={className}
    />
  );
}
