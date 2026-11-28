/**
 * Artifact gallery folders on mobile: the folder's own icon at row-icon size,
 * and the tree helpers the page and the Move sheet share.
 *
 * The icon is bare (no tile), as on web's menus: a glyph in its colour, the
 * emoji, or a plain folder. It fills the 18pt slot `SettingsRow` gives `icon`.
 */
import * as React from 'react';
import Svg, { Path } from 'react-native-svg';
import { useColorScheme } from 'nativewind';
import type { ArtifactFolder } from '@kortix/sdk';

import { glyphPath } from '@/components/kortix/avatar';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { FolderIcon } from '@/lib/icons';
import { workspaceGlyphColor } from '@/lib/ui/workspace-glyph';

const SIZE = 18;

export function ArtifactFolderGlyph({ folder }: { folder: ArtifactFolder }) {
  const dark = useColorScheme().colorScheme === 'dark';
  const path = folder.icon_glyph ? glyphPath(folder.icon_glyph.name) : undefined;
  if (folder.icon_glyph && path) {
    return (
      <Svg width={SIZE} height={SIZE} viewBox="0 0 256 256" accessible={false}>
        <Path d={path} fill={workspaceGlyphColor(folder.icon_glyph.color, dark)} />
      </Svg>
    );
  }
  if (folder.icon) {
    // The row's label names the folder: the emoji is decorative.
    return (
      <Text style={{ fontSize: SIZE - 2, lineHeight: SIZE + 2 }} allowFontScaling={false} importantForAccessibility="no">
        {folder.icon}
      </Text>
    );
  }
  return <Icon as={FolderIcon} size={SIZE} className="text-foreground/80" />;
}

/** The folders directly inside `parentId` (null: the gallery root), in the API's name order. */
export function folderChildren(folders: ArtifactFolder[], parentId: string | null) {
  return folders.filter((folder) => (folder.parent_folder_id ?? null) === parentId);
}

/** `id` and its ancestors, root first. Bounded, so a corrupt tree cannot loop. */
export function folderPath(folders: ArtifactFolder[], id: string | null): ArtifactFolder[] {
  const byId = new Map(folders.map((folder) => [folder.folder_id, folder]));
  const path: ArtifactFolder[] = [];
  for (
    let at = id ? byId.get(id) : undefined;
    at && path.length <= folders.length;
    at = at.parent_folder_id ? byId.get(at.parent_folder_id) : undefined
  ) {
    path.unshift(at);
  }
  return path;
}
