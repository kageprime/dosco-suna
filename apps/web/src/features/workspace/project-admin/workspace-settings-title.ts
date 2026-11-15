import { parseWorkspaceSettingsSection } from '@kortix/shared/workspace-settings';

/**
 * The browser tab title of Workspace settings:
 * "<Section> · Workspace settings · <workspace name>". The section is the
 * rail row's label, so the tab, the rail and the page's h1 say one word.
 * A part that is unknown (the workspace name did not load, `/admin` before it
 * picks a section) is left out, never guessed.
 */
export function workspaceSettingsTabTitle(parts: {
  section?: string | null;
  settings: string;
  workspace?: string | null;
}): string {
  return [parts.section, parts.settings, parts.workspace]
    .map((part) => part?.trim())
    .filter((part): part is string => !!part)
    .join(' · ');
}

/** The `workspaces.settings.sections.*` key of a URL segment, or `null` when the segment names no section. */
export function workspaceSettingsSectionLabelKey(segment: string | null | undefined): string | null {
  const section = parseWorkspaceSettingsSection(segment);
  return section ? section.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase()) : null;
}
