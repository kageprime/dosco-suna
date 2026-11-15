'use client';

import { cn } from '../lib/utils';
import { createContext, useContext, type ReactNode } from 'react';

/**
 * The one section header used across the Settings panel: title on the left,
 * optional description under it, one action on the right. Destructive rows use
 * this same component with a destructive-variant button in `action` — there is
 * no separate danger-zone header.
 */
export function SettingsSectionHeader({
  title,
  description,
  action,
  className,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4',
        className,
      )}
    >
      <div className="flex min-w-0 flex-col gap-1 text-base">
        <h2 className="font-regular text-foreground-strong text-base text-balance lg:text-xl">
          {title}
        </h2>
        {description ? (
          <p className="font-regular text-foreground-weak max-w-[410px] text-sm text-pretty">
            {description}
          </p>
        ) : null}
      </div>
      {action ? (
        <div className="flex w-full min-w-0 items-center gap-4 sm:w-auto sm:justify-end">
          {action}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The title of the Workspace settings page on screen: its rail row's label.
 * `ProjectAdminDashboard` provides it around the open section, so every pane
 * that draws a page header (`SettingsPageHeader`, `SettingsTabHeader`,
 * `CapabilityPageShell`, the account panes) shows the word the person clicked:
 * "Git", not "Git repo"; "Sandbox", not "Sandbox templates". `null` outside
 * Workspace settings, where each pane keeps its own title.
 */
const SettingsPageTitleContext = createContext<string | null>(null);
export const SettingsPageTitleProvider = SettingsPageTitleContext.Provider;
export function useSettingsPageTitle(): string | null {
  return useContext(SettingsPageTitleContext);
}

/**
 * Every Workspace settings page's column: one gutter and one top offset, left
 * aligned, so the title sits at the same x and y on every section. A page sets
 * only its own max width inside it (`max-w-2xl` a form, `max-w-5xl` a library,
 * none a table).
 */
export const SETTINGS_PAGE_COLUMN_CLASS = 'w-full px-4 pt-12 pb-20 sm:px-12';

/**
 * The one page-title rung of Workspace settings: the brand's section page
 * title (`typography.md`, Roles). `text-2xl` is the detail-view rung.
 */
export const SETTINGS_PAGE_TITLE_CLASS = 'text-foreground text-xl font-medium text-balance';

/**
 * The page header of a Workspace settings section: the `<h1>`, one line of
 * description under it, and the page's actions on the right. Inside Workspace
 * settings the title is the rail row's label (`SettingsPageTitleProvider`),
 * whatever the pane passes.
 */
export function SettingsPageHeader({
  title,
  titleAccessory,
  description,
  action,
  className,
}: {
  title: ReactNode;
  /** Right after the title: an info button. */
  titleAccessory?: ReactNode;
  description?: ReactNode;
  /** The page's controls (search, a primary button), one group on the right. */
  action?: ReactNode;
  className?: string;
}) {
  const navTitle = useSettingsPageTitle();
  return (
    <header
      className={cn(
        'flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4',
        className,
      )}
    >
      <div className="min-w-0 space-y-1">
        <div className="flex min-w-0 items-center gap-1">
          <h1 className={SETTINGS_PAGE_TITLE_CLASS}>{navTitle ?? title}</h1>
          {titleAccessory}
        </div>
        {description ? (
          <p className="text-muted-foreground max-w-xl text-sm text-pretty">{description}</p>
        ) : null}
      </div>
      {action ? <div className="flex min-w-0 shrink-0 items-center gap-2">{action}</div> : null}
    </header>
  );
}
