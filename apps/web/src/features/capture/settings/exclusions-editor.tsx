'use client';

import { CAPTURE_EXCLUSION_GROUPS, type CaptureExclusionGroup } from '@kortix/sdk';
import {
  AppWindowIcon,
  BankIcon,
  ChatCircleIcon,
  EyeSlashIcon,
  KeyIcon,
  MagnifyingGlassIcon,
  PlusIcon,
  ShieldCheckIcon,
  type Icon,
} from '@phosphor-icons/react';
import { useState } from 'react';

import { useTranslations } from '@/i18n/use-translations';

import {
  catalogApp,
  catalogSuggestions,
  namedAppRows,
  siteSuggestions,
} from './capture-app-catalog';
import { CaptureListEditor, ExclusionItem, RowSection, Tile } from './capture-list-editor';
import {
  exclusionLists,
  type ExclusionChange,
  type ExclusionTab,
  type ExclusionsView,
  type IncludedView,
} from './exclusions-model';

const GROUP_ICONS: Record<string, Icon> = {
  password_managers: KeyIcon,
  messaging: ChatCircleIcon,
  banking: BankIcon,
};

/**
 * The organization's Exclusions (account settings ▸ Dosco Capture): Apps |
 * Websites, the categories, private browsing and what is excluded. The
 * mandatory lists every device applies; apps and websites are added by id from
 * the search box. Each row is one checkbox.
 */
export function ExclusionsEditor({
  view,
  org,
  onChange,
}: {
  view: ExclusionsView;
  org: string;
  onChange: (change: ExclusionChange) => void;
}) {
  const t = useTranslations('capture.settings.exclusions');
  const tGroup = useTranslations('capture.settings.exclusions.group');
  return (
    <CaptureListEditor
      onChange={onChange}
      kind={(apps) => (apps ? 'app' : 'domain')}
      view={view}
      rows={(apps, query) => exclusionLists(view, apps ? 'apps' : 'websites', query).excluded}
      suggestions={(apps, query) =>
        apps
          ? catalogSuggestions(
              view.apps.map((r) => r.id),
              query,
            ).map((a) => ({ key: a.name, name: a.name, ids: a.ids }))
          : siteSuggestions(
              view.domains.map((r) => r.id),
              query,
            ).map((d) => ({ key: d, name: d, ids: [d] }))
      }
      labels={{
        t,
        search: (apps) => t(apps ? 'searchOrAddApp' : 'searchWebsites'),
        listTitle: t('excluded'),
        empty: (apps, query) =>
          query.trim() ? t('noMatch') : t(apps ? 'noExcludedApps' : 'noExcludedSites'),
      }}
      searchIcon={MagnifyingGlassIcon}
      className="space-y-6"
      header={<p className="text-muted-foreground text-xs text-pretty">{t('orgIntro', { org })}</p>}
    >
      {(apps, query) => {
        const known = (id: string): id is CaptureExclusionGroup =>
          (CAPTURE_EXCLUSION_GROUPS as readonly string[]).includes(id);
        const lists = exclusionLists(view, apps ? 'apps' : 'websites', query);
        return lists.categories.length > 0 || (!apps && !query.trim()) ? (
          <RowSection title={t('categories')}>
            {lists.categories.map((group) => {
              const count = apps ? group.apps : group.domains;
              const summary =
                count === null ? '' : apps ? t('appCount', { count }) : t('siteCount', { count });
              return (
                <CategoryItem
                  key={group.id}
                  icon={GROUP_ICONS[group.id] ?? ShieldCheckIcon}
                  title={known(group.id) ? tGroup(group.id) : group.name}
                  description={summary}
                  members={apps ? memberApps(group.members.apps) : group.members.domains}
                  showLabel={t('showList')}
                  hideLabel={t('hideList')}
                  checked={group.enabled}
                  onChange={(on) => onChange({ kind: 'group', id: group.id, on })}
                />
              );
            })}
            {!apps && !query.trim() ? (
              <ExclusionItem
                leading={<Tile icon={EyeSlashIcon} />}
                title={t('privateBrowsing')}
                description={t('privateBrowsingDescription')}
                checked={view.privateBrowsing.excluded}
                onChange={(on) => onChange({ kind: 'private-browsing', on })}
              />
            ) : null}
          </RowSection>
        ) : null;
      }}
    </CaptureListEditor>
  );
}

/** A category's apps by name (one name per app, its macOS and Windows ids together). */
function memberApps(ids: string[]): string[] {
  const names = ids.map((id) => catalogApp(id)?.name ?? id);
  return [...new Set(names)];
}

/** A category row whose list opens below it: exactly what the category covers. */
function CategoryItem({
  icon,
  title,
  description,
  members,
  showLabel,
  hideLabel,
  checked,
  onChange,
}: {
  icon: Icon;
  title: string;
  description: string;
  members: string[];
  showLabel: string;
  hideLabel: string;
  checked: boolean;
  onChange: (on: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <ExclusionItem
        leading={<Tile icon={icon} />}
        title={title}
        description={
          <span className="flex items-center gap-1.5">
            {description}
            {members.length > 0 ? (
              <button
                type="button"
                className="text-foreground underline-offset-2 hover:underline"
                aria-expanded={open}
                onClick={() => setOpen((v) => !v)}
              >
                {open ? hideLabel : showLabel}
              </button>
            ) : null}
          </span>
        }
        checked={checked}
        onChange={onChange}
      />
      {open ? (
        <li className="pb-2.5 pl-11">
          <p className="text-muted-foreground max-h-40 overflow-y-auto text-xs leading-relaxed">
            {members.join(', ')}
          </p>
        </li>
      ) : null}
    </>
  );
}

/**
 * Record only included (account settings ▸ Dosco Capture): Apps | Websites the
 * organization includes. An included app is recorded in full; an included website
 * in any browser. Everything else is blacked out. People can add their own.
 */
export function IncludedEditor({
  view,
  onChange,
}: {
  view: IncludedView;
  onChange: (change: ExclusionChange) => void;
}) {
  const t = useTranslations('capture.settings.included');
  return (
    <CaptureListEditor
      onChange={onChange}
      kind={(apps) => (apps ? 'include-app' : 'include-domain')}
      view={view}
      rows={(apps) => (apps ? view.apps : view.domains)}
      suggestions={(apps, query) =>
        apps
          ? catalogSuggestions(
              view.apps.map((r) => r.id),
              query,
            ).map((a) => ({ key: a.name, name: a.name, ids: a.ids }))
          : siteSuggestions(
              view.domains.map((r) => r.id),
              query,
            ).map((d) => ({ key: d, name: d, ids: [d] }))
      }
      labels={{
        t,
        search: (apps) => t(apps ? 'addAppPlaceholder' : 'addSitePlaceholder'),
        listTitle: t('included'),
        empty: (apps) => t(apps ? 'noApps' : 'noSites'),
      }}
      searchIcon={PlusIcon}
      className="space-y-4"
    />
  );
}
