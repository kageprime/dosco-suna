'use client';

import type { FlatModel } from '@kortix/sdk/react';
import { StarIcon } from '@phosphor-icons/react';
import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

import { useTranslations } from '../../i18n';
import { SolidCheckIcon } from '../../internal/icons/solid-check-icon';
import { MODEL_SELECTOR_PROVIDER_IDS, ProviderLogo } from '../../internal/lib/provider-branding';
import { cn } from '../../lib/utils';
import { foreignDialogOpen, openDialogs } from '../../lib/z-stack';
import { Button } from '../../primitives/button';
import { CommandGroup, CommandInput, CommandItem, CommandList } from '../../primitives/command';
import { Kbd } from '../../primitives/kbd';
import Loading from '../../primitives/loading';
import { Tag } from '../../primitives/tag';
import { EffortIcon, effortLabel } from '../composer/reasoning-effort-selector';
import {
  initialPickerTab,
  modelItemValue,
  pickerGroupId,
  pickerGroupLabel,
  pickerTabOf,
  pickerTabs,
  splitModelLabel,
  type PickerTabId,
} from './model-grouping';
import { pickerModelName, shouldShowFreeTag } from './model-tags';

type ModelRef = { providerID: string; modelID: string };

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform);
const MOD = IS_MAC ? '⌘' : 'Ctrl';

/** Rows past the ninth have no digit to bind. */
const SHORTCUT_ROWS = 9;

const SCROLLBAR_HIDE_CLASS =
  'scrollbar-hide [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden';

const sameModel = (a: ModelRef | null | undefined, b: ModelRef) =>
  !!a && a.providerID === b.providerID && a.modelID === b.modelID;

export interface ModelPickerPanelProps {
  /** Every pickable model with no search applied: the rail and the tabs read these. */
  browseModels: FlatModel[];
  /**
   * Every model the member may pick, before the default-view curation. Favorites
   * read these: a model starred from a search stays in Favorites after the
   * search is cleared, though the default view would hide it.
   */
  pickableModels: FlatModel[];
  /** The models that match the search box. Used only while a search is typed. */
  searchModels: FlatModel[];
  search: string;
  onSearchChange: (value: string) => void;
  /** Controls at the right end of the search field (connect, manage). */
  searchRight?: ReactNode;
  selected: ModelRef | null;
  /** Workspace default model, prioritized alongside favorites in the primary list. */
  accountDefault?: ModelRef | null;
  onPick: (model: FlatModel) => void;
  isFavorite: (model: ModelRef) => boolean;
  setFavorite: (model: ModelRef, on: boolean) => void;
  /** Models or entitlements still load. */
  loading: boolean;
  /** Nothing is pickable at all: the connect / upgrade empty state. */
  emptyState: ReactNode;
  /** The search matched nothing. */
  searchEmpty: ReactNode;
  /** Present when the member can connect a ChatGPT plan from here. */
  onConnectChatGpt?: () => void;
  /** Tag for a model whose provider is not connected. */
  connectLabel: string;
  /** Active subscription provider when the current model bills to a connected login. */
  subscriptionProvider?: 'codex' | 'claude-agent' | null;
  /** Present when free-tier members can upgrade from the footer. */
  onUpgrade?: () => void;
  /**
   * Another dialog opened (the command palette, a modal). The popover sits
   * above every top-level dialog, so it must close rather than float over it.
   */
  onForeignDialog?: () => void;
  /** Thinking effort for the selected model. */
  effort?: {
    choices: readonly string[];
    selectedVariant: string | null | undefined;
    onChange: (variant: string | null) => void;
  };
}

/**
 * Compact Single-Column Model Picker:
 * - Single slim column (~300px) that stays small and does not interfere with screen content.
 * - Horizontal provider filter strip below the search bar.
 * - Clean scrollable list with zero visible scroll wheels.
 * - Inline thinking effort pills at the bottom (when applicable).
 */
export function ModelPickerPanel({
  browseModels,
  pickableModels,
  searchModels,
  search,
  onSearchChange,
  searchRight,
  selected,
  onPick,
  isFavorite,
  setFavorite,
  loading,
  emptyState,
  searchEmpty,
  onConnectChatGpt,
  connectLabel,
  effort,
  onForeignDialog,
}: ModelPickerPanelProps) {
  const t = useTranslations('modelSelector');
  const tPooled = useTranslations('pooledSecrets');

  const favorites = useMemo(() => pickableModels.filter(isFavorite), [pickableModels, isFavorite]);
  const providerTabs = useMemo(
    () =>
      pickerTabs(browseModels, {
        canConnectChatGpt: !!onConnectChatGpt,
        providerOrder: MODEL_SELECTOR_PROVIDER_IDS,
      }),
    [browseModels, onConnectChatGpt],
  );

  const selectedModel = useMemo(
    () => (selected ? browseModels.find((m) => sameModel(selected, m)) : undefined),
    [browseModels, selected],
  );

  const [chosenTab, setChosenTab] = useState<string | null>(null);

  const defaultTab = useMemo(() => {
    if (favorites.length > 0 && selectedModel && isFavorite(selectedModel)) return 'favorites';
    return 'all';
  }, [favorites.length, selectedModel, isFavorite]);

  const activeTab = chosenTab ?? defaultTab;
  const searching = search.trim().length > 0;

  // Mounted only while the popover is open.
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!onForeignDialog) return;
    const host = new Set<Element>(openDialogs());
    const check = () => {
      if (foreignDialogOpen(rootRef.current, host)) onForeignDialog();
    };
    const observer = new MutationObserver(check);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-state'],
    });
    return () => observer.disconnect();
  }, [onForeignDialog]);

  const rows = useMemo(() => {
    if (searching) return searchModels;
    if (activeTab === 'all') return browseModels;
    if (activeTab === 'favorites') return favorites;
    return browseModels.filter((m) => pickerTabOf(m) === activeTab);
  }, [searching, searchModels, activeTab, favorites, browseModels]);

  const sections = useMemo(() => [{ id: searching ? 'search' : activeTab, models: rows }], [searching, activeTab, rows]);
  const ordered = useMemo(() => sections.flatMap((s) => s.models), [sections]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!(IS_MAC ? event.metaKey : event.ctrlKey) || event.altKey || event.shiftKey) return;
    if (!/^[1-9]$/.test(event.key)) return;
    const model = ordered[Number(event.key) - 1];
    if (!model) return;
    event.preventDefault();
    event.stopPropagation();
    onPick(model);
  };

  const tabLabel = (id: string) => {
    if (id === 'all') return t('all') || 'All';
    if (id === 'favorites') return t('favorites');
    if (id === 'kortix') return 'Dosco';
    if (id === 'chatgpt') return 'ChatGPT';
    const sample = browseModels.find((m) => pickerTabOf(m) === id);
    return sample ? pickerGroupLabel(id as PickerTabId, sample) : id;
  };

  // Build filter pills: All, Favorites (if any), then provider tabs
  const filterPills = useMemo(() => {
    const pills: string[] = ['all'];
    if (favorites.length > 0) pills.push('favorites');
    for (const pt of providerTabs) {
      if (pt !== 'favorites' && !pills.includes(pt)) {
        pills.push(pt);
      }
    }
    return pills;
  }, [favorites.length, providerTabs]);

  let body: ReactNode;
  if (loading) {
    body = (
      <div className="flex h-32 items-center justify-center" role="status" aria-label={t('loading')}>
        <Loading className="text-muted-foreground size-4 shrink-0" />
      </div>
    );
  } else if (browseModels.length === 0 && !searching) {
    body = emptyState;
  } else if (searching && rows.length === 0) {
    body = searchEmpty;
  } else if (rows.length === 0 && activeTab === 'favorites') {
    body = <p className="text-muted-foreground px-3 py-6 text-center text-xs">{t('favoritesEmpty')}</p>;
  } else if (rows.length === 0 && activeTab === 'chatgpt' && onConnectChatGpt) {
    body = (
      <div className="flex justify-center px-3 py-6">
        <Button type="button" size="xs" variant="outline" onClick={onConnectChatGpt}>
          {tPooled('connectChatGpt')}
        </Button>
      </div>
    );
  } else {
    let index = 0;
    body = sections.map((section) => (
      <Fragment key={section.id}>
        <CommandGroup forceMount className="p-0.5">
          {section.models.map((model) => {
            index += 1;
            return (
              <PickerRow
                key={`${model.providerID}:${model.modelID}`}
                model={model}
                isSelected={sameModel(selected, model)}
                favorite={isFavorite(model)}
                onToggleFavorite={(on) => setFavorite(model, on)}
                onSelect={() => onPick(model)}
                shortcut={index <= SHORTCUT_ROWS ? index : null}
                connectLabel={connectLabel}
              />
            );
          })}
        </CommandGroup>
      </Fragment>
    ));
  }

  return (
    <div
      ref={rootRef}
      className="bg-popover flex min-w-0 flex-col overflow-hidden"
      onKeyDown={onKeyDown}
    >
      {/* Top Search Input */}
      <div className="border-b border-border/40">
        <CommandInput
          compact
          placeholder={t('search')}
          value={search}
          onValueChange={onSearchChange}
          rightElement={searchRight}
        />
      </div>

      {/* Horizontal Filter Tabs (Single-column, zero vertical rail) */}
      {!searching && filterPills.length > 2 ? (
        <div
          role="tablist"
          aria-label={t('groups')}
          className={cn(
            SCROLLBAR_HIDE_CLASS,
            'border-border/40 flex items-center gap-1 overflow-x-auto border-b px-2 py-1.5',
          )}
        >
          {filterPills.map((id) => {
            const active = id === activeTab;
            return (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => {
                  setChosenTab(id);
                  if (searching) onSearchChange('');
                }}
                onKeyDown={keepKeyOnButton}
                className={cn(
                  'flex h-5.5 shrink-0 cursor-pointer items-center gap-1 rounded px-2 text-[11px] font-medium outline-none transition-colors',
                  'focus-visible:ring-ring focus-visible:ring-1',
                  active
                    ? 'bg-foreground text-background font-semibold shadow-xs'
                    : 'text-muted-foreground hover:bg-hover hover:text-foreground',
                )}
              >
                {id === 'favorites' ? (
                  <StarIcon weight="fill" className={cn('size-3', active ? 'text-background' : 'text-kortix-orange')} />
                ) : null}
                <span>{tabLabel(id)}</span>
              </button>
            );
          })}
        </div>
      ) : null}

      {/* Scrollable Model List without visible scrollbars */}
      <CommandList
        className={cn(
          SCROLLBAR_HIDE_CLASS,
          'max-h-[min(17rem,42vh)] min-h-0 flex-1 overflow-y-auto px-1 py-1',
        )}
      >
        {body}
      </CommandList>

      {/* Inline Thinking Effort strip at the bottom of the single column */}
      {effort && effort.choices.length > 0 ? (
        <div className="border-border/40 bg-muted/15 flex items-center justify-between gap-1.5 border-t px-2.5 py-1.5 text-xs">
          <div className="flex shrink-0 items-center gap-1 text-[11px] font-medium text-muted-foreground">
            <EffortIcon value={effort.selectedVariant ?? null} className="size-3.5" />
            <span>{t('thinking')}</span>
          </div>
          <div
            className={cn(
              SCROLLBAR_HIDE_CLASS,
              'flex items-center gap-1 overflow-x-auto',
            )}
          >
            <button
              type="button"
              onClick={() => effort.onChange(null)}
              className={cn(
                'h-5 shrink-0 cursor-pointer rounded px-1.5 text-[11px] font-medium transition-colors outline-none',
                effort.selectedVariant == null
                  ? 'bg-foreground text-background font-semibold'
                  : 'text-muted-foreground hover:bg-hover hover:text-foreground',
              )}
            >
              Auto
            </button>
            {effort.choices.map((choice) => (
              <button
                key={choice}
                type="button"
                onClick={() => effort.onChange(choice)}
                className={cn(
                  'h-5 shrink-0 cursor-pointer rounded px-1.5 text-[11px] font-medium capitalize transition-colors outline-none',
                  effort.selectedVariant === choice
                    ? 'bg-foreground text-background font-semibold'
                    : 'text-muted-foreground hover:bg-hover hover:text-foreground',
                )}
              >
                {effortLabel(choice)}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function keepKeyOnButton(event: KeyboardEvent<HTMLButtonElement>) {
  if (event.key === 'Enter' || event.key === ' ') event.stopPropagation();
}

function PickerRow({
  model,
  isSelected,
  favorite,
  onToggleFavorite,
  onSelect,
  shortcut,
  connectLabel,
}: {
  model: FlatModel;
  isSelected: boolean;
  favorite: boolean;
  onToggleFavorite: (on: boolean) => void;
  onSelect: () => void;
  shortcut: number | null;
  connectLabel: string;
}) {
  const t = useTranslations('modelSelector');
  const unavailable = model.available === false || model.unavailable === true;
  const groupID = pickerGroupId(model);
  const { lead, trail } = splitModelLabel(pickerModelName(model));

  return (
    <CommandItem
      value={modelItemValue('model', model)}
      title={model.modelID}
      onSelect={onSelect}
      className={cn(
        'group h-8 gap-2 rounded-md px-2 text-xs',
        'hover:bg-hover [&:not([data-nav=pointer]_*)]:data-[selected=true]:bg-hover',
        isSelected && 'bg-active [&:not([data-nav=pointer]_*)]:data-[selected=true]:bg-active font-medium',
      )}
    >
      <ProviderLogo
        providerID={groupID}
        name={pickerGroupLabel(groupID, model)}
        size="xs"
        className="size-4 shrink-0 rounded-xs"
      />
      <span className={cn('min-w-0 flex-1 truncate leading-tight text-xs', unavailable && 'opacity-60')}>
        <span className="text-foreground font-medium">{lead}</span>
        {trail ? <span className="text-muted-foreground font-normal"> {trail}</span> : null}
      </span>
      {isSelected ? <SolidCheckIcon className="text-ring size-3.5 shrink-0" /> : null}

      {unavailable ? (
        <Tag className="text-[10px] py-0 px-1">{connectLabel}</Tag>
      ) : shouldShowFreeTag(model) ? (
        <Tag variant="free" className="text-[10px] py-0 px-1">{t('free')}</Tag>
      ) : null}

      <button
        type="button"
        aria-label={
          favorite
            ? t('removeFavorite', { model: model.modelName })
            : t('addFavorite', { model: model.modelName })
        }
        aria-pressed={favorite}
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={keepKeyOnButton}
        onClick={(e) => {
          e.stopPropagation();
          onToggleFavorite(!favorite);
        }}
        className={cn(
          'flex size-5 shrink-0 cursor-pointer items-center justify-center rounded',
          'text-muted-foreground hover:text-kortix-orange hover:bg-foreground/10',
          'duration-normal transition-[color,background-color,transform] ease-out motion-safe:active:scale-[0.96]',
          'focus-visible:ring-ring focus-visible:ring-1 focus-visible:outline-none',
          favorite
            ? 'text-kortix-orange hover:text-kortix-orange'
            : 'pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-data-[selected=true]:pointer-events-auto group-data-[selected=true]:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100',
        )}
      >
        <StarIcon
          weight={favorite ? 'fill' : 'regular'}
          className={cn('size-3.5', favorite ? 'text-kortix-orange' : 'text-current')}
        />
      </button>

      {shortcut ? (
        <Kbd className="bg-muted h-4 w-auto min-w-4.5 shrink-0 text-[9px] tabular-nums px-1">
          {MOD}
          {shortcut}
        </Kbd>
      ) : null}
    </CommandItem>
  );
}
