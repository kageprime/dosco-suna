import { isMyKortixAgentName, MY_KORTIX_DISPLAY_NAME } from './my-kortix-agent';

/** The longest channel slug the API stores. */
const SPACE_SLUG_MAX = 40;

/**
 * A channel's slug from its name: lowercase, whitespace runs → `-`, other
 * characters dropped, `-` runs collapsed and trimmed, at most 40 characters.
 * Empty when the name has no `a-z0-9`. The API derives the stored slug with
 * this function, and the create dialog previews it, so the two never differ.
 */
export function spaceSlug(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .slice(0, SPACE_SLUG_MAX)
    .replace(/^-+|-+$/g, '');
}

/** Where every public channel's folder lives in the project's Files. Nothing grants it to the project: admins and agents granted it reach it. */
const SPACE_CHANNELS_DIR = '/Company/Channels';

/**
 * Where every private channel's folder lives: outside `/Company`, so project
 * admins never reach it. Only the
 * channel's members (one grant each) and the channel's own threads do. The
 * folder is named by the channel's id, never its name: a rename moves
 * nothing, and a later channel that takes the name never inherits the folder.
 * Only `/Channels/<space_id>` of a private channel of the project is reserved;
 * any other path under `/Channels` is an ordinary folder (the API's
 * `privateChannelFolderOf`).
 */
export const PRIVATE_CHANNELS_DIR = '/Channels';

/** One plain path segment: no `/`, no `..`, no control or space characters. */
const FOLDER_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * A space's two folders in the project's Files (drive paths). A public
 * channel's are `/Company/Channels/<slug>` and its `Memory`. A private channel's are `/Channels/<space_id>` and its `Memory`
 * (pass its id as `privateSpaceId`). A DM's
 * are in the member's own folder: `<personal>/Agents/<agent>` and its
 * memory `<personal>/Memory/<agent>` (the agent folder of the DM's Memory
 * tab, which also lists the rest of `<personal>/Memory`). Null for a DM without a personal folder,
 * and for a name that is not one plain path segment (an agent name is not
 * validated as one when the DM is opened).
 * The API (folder create, rename, the session's /drives/README.md) and the web
 * tabs read this, so both name the same folders.
 */
export function spaceDriveFolders(
  kind: 'channel' | 'dm',
  name: string,
  personalFolder: string | null,
  /** A private channel's id; null for a public channel or a DM. */
  privateSpaceId: string | null = null,
): { files: string; memory: string } | null {
  if (kind === 'channel' && privateSpaceId) {
    if (!FOLDER_SEGMENT.test(privateSpaceId)) return null;
    const files = `${PRIVATE_CHANNELS_DIR}/${privateSpaceId}`;
    return { files, memory: `${files}/Memory` };
  }
  if (!FOLDER_SEGMENT.test(name)) return null;
  if (kind === 'channel') {
    const files = `${SPACE_CHANNELS_DIR}/${name}`;
    return { files, memory: `${files}/Memory` };
  }
  if (!personalFolder) return null;
  return { files: `${personalFolder}/Agents/${name}`, memory: `${personalFolder}/Memory/${name}` };
}

/**
 * Display label for a Drive folder or path leaf: the built-in coordinator's
 * storage folders (`<personal>/Agents/mykortix`, `<personal>/Memory/mykortix`,
 * and legacy aliases) keep `mykortix` on disk so existing Drive volumes and
 * agent mounts stay compatible, and read as `Xera` in Files views and crumbs.
 */
export function driveEntryDisplayName(drivePath: string, fallbackName?: string): string {
  const parts = drivePath.split('/').filter(Boolean);
  if (
    parts.length === 4 &&
    parts[0] === 'Users' &&
    (parts[2] === 'Agents' || parts[2] === 'Memory') &&
    isMyKortixAgentName(parts[3])
  ) {
    return MY_KORTIX_DISPLAY_NAME;
  }
  return fallbackName ?? parts.at(-1) ?? drivePath;
}

/**
 * Breadcrumb labels from `basePath` (labeled `rootLabel`) down to `path`,
 * formatting each segment with {@link driveEntryDisplayName}.
 */
export function driveRelativeDisplayCrumbs(rootLabel: string, path: string, basePath?: string | null): string[] {
  const baseParts = basePath ? basePath.split('/').filter(Boolean) : [];
  const parts = path.split('/').filter(Boolean);
  return [
    rootLabel,
    ...parts
      .slice(baseParts.length)
      .map((segment, index) => driveEntryDisplayName(`/${parts.slice(0, baseParts.length + index + 1).join('/')}`, segment)),
  ];
}

/**
 * A space's folder in the project's Files (flag `session_groups`; a space is a
 * session group): `/Spaces/<group_id>`. Outside `/Company`, like a private
 * channel's: only the people who see the space reach it (admins only under
 * account session oversight). Named by the group's id, never its name: a
 * rename moves nothing, and a later space that takes the name never inherits
 * the folder. Every session of the space mounts it read-write. Null for an id
 * that is not one plain path segment.
 */
export function sessionGroupDriveFolder(groupId: string): string | null {
  return FOLDER_SEGMENT.test(groupId) ? `${SESSION_GROUPS_DIR}/${groupId}` : null;
}

/** Where every space's folder lives (`sessionGroupDriveFolder`). */
export const SESSION_GROUPS_DIR = '/Spaces';
