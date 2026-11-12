'use client';

import {
  normalizeCaptureAppId,
  normalizeCaptureDomain,
} from '@kortix/sdk';
import { AppWindowIcon, GlobeIcon, PlusIcon, type Icon } from '@phosphor-icons/react';
import { useState, type ReactNode } from 'react';

import { Button } from '@kortix/ui/button';
import { Checkbox } from '@kortix/ui/checkbox';
import {
  InputGroupSearch,
  InputGroupSearchIcon,
  InputGroupSearchInput,
} from '@kortix/ui/input-group';
import { Label } from '@kortix/ui/label';
import { Tabs, TabsList, TabsTrigger } from '@kortix/ui/tabs';
import { useTranslations } from '@/i18n/use-translations';

import { namedAppRows } from './capture-app-catalog';
import { type ExclusionChange, type ExclusionRow, type ExclusionTab } from './exclusions-model';

type Translator = ReturnType<typeof useTranslations>;

/** A titled section of flat rows. */
export function RowSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-1">
      <div className="flex min-h-8 items-center">
        <Label>{title}</Label>
      </div>
      <ul className="divide-border divide-y">{children}</ul>
    </section>
  );
}

/** One row: leading tile, title, one muted line, the checkbox. */
export function ExclusionItem({
  leading,
  title,
  description,
  checked,
  onChange,
}: {
  leading: ReactNode;
  title: string;
  description?: ReactNode;
  checked: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <li className="flex items-center gap-3 py-2.5">
      {leading}
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="truncate text-sm">{title}</p>
        {description ? (
          <p className="text-muted-foreground truncate text-xs">{description}</p>
        ) : null}
      </div>
      <Checkbox
        checked={checked}
        onCheckedChange={(value) => onChange(value === true)}
        aria-label={title}
      />
    </li>
  );
}

export function Tile({ icon: TileIcon }: { icon: Icon }) {
  return (
    <span className="bg-muted text-muted-foreground flex size-8 shrink-0 items-center justify-center rounded-sm">
      <TileIcon className="size-4" />
    </span>
  );
}

/**
 * The capture list editor the organization's Exclusions and Record-only-included
 * editors share: the Apps | Websites switcher, the search-or-add box, the add
 * button, QuickAdd and the list. The caller provides what differs: the change
 * kinds, the rows, the suggestions, the strings, and any section between the
 * add button and the list (the categories and private browsing).
 */
export function CaptureListEditor({
  onChange,
  kind,
  view,
  rows,
  suggestions,
  labels,
  searchIcon,
  className,
  header,
  children,
}: {
  onChange: (change: ExclusionChange) => void;
  /** The change kind each tab emits. */
  kind: (apps: boolean) => ExclusionChange['kind'];
  /** The current rows of each tab: what the add box dedupes against. */
  view: { apps: ExclusionRow[]; domains: ExclusionRow[] };
  /** The rows the list shows. */
  rows: (apps: boolean, query: string) => ExclusionRow[];
  /** The common apps or websites not in the list yet, one click each. */
  suggestions: (apps: boolean, query: string) => { key: string; name: string; ids: string[] }[];
  /** The strings: the shared keys go through `t`, the per-editor keys resolved here. */
  labels: {
    t: Translator;
    search: (apps: boolean) => string;
    listTitle: string;
    empty: (apps: boolean, query: string) => string;
  };
  searchIcon: Icon;
  className: string;
  header?: ReactNode;
  children?: (apps: boolean, query: string) => ReactNode;
}) {
  const { t } = labels;
  const [tab, setTab] = useState<ExclusionTab>('apps');
  const [query, setQuery] = useState('');
  const apps = tab === 'apps';
  const changeKind = kind(apps);
  const addable = apps ? normalizeCaptureAppId(query) : normalizeCaptureDomain(query);
  const canAdd = addable && !(apps ? view.apps : view.domains).some((row) => row.id === addable);
  const add = () => {
    if (!canAdd) return;
    onChange({ kind: changeKind, id: addable, on: true });
    setQuery('');
  };
  const SearchIcon = searchIcon;

  return (
    <div className={className}>
      {header}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <Tabs value={tab} onValueChange={(value) => setTab(value as ExclusionTab)}>
          <TabsList aria-label={t('kindLabel')}>
            <TabsTrigger value="apps">{t('apps')}</TabsTrigger>
            <TabsTrigger value="websites">{t('websites')}</TabsTrigger>
          </TabsList>
        </Tabs>
        <InputGroupSearch className="flex-1">
          <InputGroupSearchIcon>
            <SearchIcon />
          </InputGroupSearchIcon>
          <InputGroupSearchInput
            size="sm"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return;
              event.preventDefault();
              add();
            }}
            placeholder={labels.search(apps)}
            aria-label={labels.search(apps)}
          />
        </InputGroupSearch>
      </div>

      {canAdd ? (
        <Button variant="outline" size="sm" className="gap-1.5" onClick={add}>
          <PlusIcon className="size-3.5 shrink-0" />
          {apps ? t('addApp', { app: addable }) : t('addDomain', { domain: addable })}
        </Button>
      ) : null}

      {children ? children(apps, query) : null}

      <QuickAdd
        label={t(apps ? 'commonApps' : 'commonSites')}
        items={suggestions(apps, query)}
        onAdd={(ids) => {
          ids.forEach((id) => onChange({ kind: changeKind, id, on: true }));
          setQuery('');
        }}
      />

      <ExclusionList
        title={labels.listTitle}
        empty={labels.empty(apps, query)}
        rows={rows(apps, query)}
        apps={apps}
        onChange={(id, on) => onChange({ kind: changeKind, id, on })}
      />
    </div>
  );
}

/** A list: every row checked; unchecking one removes it. Apps show by name, one row per app. */
function ExclusionList({
  title,
  empty,
  rows,
  apps,
  onChange,
}: {
  title: string;
  empty: string;
  rows: ExclusionRow[];
  apps: boolean;
  onChange: (id: string, on: boolean) => void;
}) {
  const shown = apps
    ? namedAppRows(rows)
    : rows.map((row) => ({ ids: [row.id], name: row.name, detail: '' }));
  return (
    <RowSection title={title}>
      {shown.length === 0 ? (
        <li className="text-muted-foreground py-2.5 text-xs">{empty}</li>
      ) : (
        shown.map((row) => (
          <ExclusionItem
            key={row.ids.join(' ')}
            leading={<Tile icon={apps ? AppWindowIcon : GlobeIcon} />}
            title={row.name}
            description={row.detail || undefined}
            checked
            onChange={(on) => row.ids.forEach((id) => onChange(id, on))}
          />
        ))
      )}
    </RowSection>
  );
}

/** Common apps or websites not in the list yet, one click each. */
function QuickAdd({
  label,
  items,
  onAdd,
}: {
  label: string;
  items: { key: string; name: string; ids: string[] }[];
  onAdd: (ids: string[]) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <div className="flex flex-wrap gap-1.5">
        {items.slice(0, 12).map((item) => (
          <Button
            key={item.key}
            variant="outline"
            size="sm"
            className="gap-1"
            onClick={() => onAdd(item.ids)}
          >
            <PlusIcon className="size-3 shrink-0" />
            {item.name}
          </Button>
        ))}
      </div>
    </div>
  );
}
