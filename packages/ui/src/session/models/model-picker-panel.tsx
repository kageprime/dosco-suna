'use client';

import type { FlatModel } from '@kortix/sdk/react';
import {
  CaretRightIcon,
  CheckIcon,
  GaugeIcon,
  InfoIcon,
  MagnifyingGlassIcon,
  StarIcon,
} from '@phosphor-icons/react';
import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';

import { useTranslations } from '../../i18n';
import { MODEL_SELECTOR_PROVIDER_IDS, ProviderLogo } from '../../internal/lib/provider-branding';
import { cn } from '../../lib/utils';
import { foreignDialogOpen, openDialogs } from '../../lib/z-stack';
import { Button } from '../../primitives/button';
import { CommandGroup, CommandInput, CommandItem, CommandList } from '../../primitives/command';
import Loading from '../../primitives/loading';
import { Tag } from '../../primitives/tag';
import { effortLabel } from '../composer/reasoning-effort-selector';
import {
  modelItemValue,
  pickerGroupId,
  pickerGroupLabel,
  pickerTabOf,
  pickerTabs,
  type PickerTabId,
} from './model-grouping';
import { isAntigravitySubscriptionModel, pickerModelName, shouldShowFreeTag } from './model-tags';

type ModelRef = { providerID: string; modelID: string };

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform);
const SHORTCUT_ROWS = 9;

const SCROLLBAR_HIDE_CLASS =
  'scrollbar-hide [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden';

const sameModel = (a: ModelRef | null | undefined, b: ModelRef | null | undefined) =>
  !!a && !!b && a.providerID === b.providerID && a.modelID === b.modelID;

const modelKey = (m: ModelRef) => `${m.providerID}:${m.modelID}`;

function modelEffortChoices(model: FlatModel): string[] {
  const keys = model.variants ? Object.keys(model.variants) : [];
  return Array.from(new Set(keys.filter((v) => typeof v === 'string' && v.length > 0)));
}

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
  /** Controls at the right end of the header/search bar (connect, manage). */
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
  /** Opens provider usage / connection management ("View Usage"). */
  onViewUsage?: () => void;
  /** Render compactly inside a parent pane without floating outside horizontally. */
  inlineMode?: boolean;
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
 * Antigravity-style Model Picker:
 * - Clean `Model` header (plus optional search toggle & compact provider filter pills).
 * - Crisp rows showing `Name`, muted inline effort (`Medium`), and pill badges (`New`, `New ⓘ`, `Notice ⓘ`, `Unavailable ⓘ`).
 * - Trailing `✓` for selected model or `>` chevron for models with effort variants.
 * - Floating effort submenu card to the right (`Low`, `Medium ✓`, `High`, `Extra` / `Max`) on hover or chevron tap,
 *   plus an inline fallback in narrow / inline panes.
 * - `View Usage >` footer row.
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
  onViewUsage,
  inlineMode = false,
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
  const [searchOpen, setSearchOpen] = useState(false);

  const defaultTab = useMemo(() => {
    if (favorites.length > 0 && selectedModel && isFavorite(selectedModel)) return 'favorites';
    if (selectedModel) {
      const tab = pickerTabOf(selectedModel);
      if (providerTabs.includes(tab)) return tab;
    }
    return 'all';
  }, [favorites.length, selectedModel, isFavorite, providerTabs]);

  const activeTab = chosenTab ?? defaultTab;
  const searching = search.trim().length > 0;
  const showSearchInput = searchOpen || searching || browseModels.length > 10;

  // Mounted only while the popover is open.
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

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

  // Apply deferred variant selection immediately after switching to a different model.
  const pendingEffortRef = useRef<{ model: ModelRef; variant: string | null } | null>(null);
  useEffect(() => {
    const pending = pendingEffortRef.current;
    if (!pending || !selected || !effort?.onChange) return;
    if (sameModel(selected, pending.model)) {
      pendingEffortRef.current = null;
      effort.onChange(pending.variant);
    }
  }, [selected, effort]);

  const [submenu, setSubmenu] = useState<{ model: FlatModel; top: number } | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearCloseTimer = useCallback(() => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  const scheduleCloseSubmenu = useCallback(() => {
    clearCloseTimer();
    closeTimerRef.current = setTimeout(() => {
      setSubmenu(null);
    }, 140);
  }, [clearCloseTimer]);

  useEffect(() => () => clearCloseTimer(), [clearCloseTimer]);

  const openSubmenuForRow = useCallback(
    (model: FlatModel, rowEl: HTMLElement | null) => {
      clearCloseTimer();
      const choices = modelEffortChoices(model);
      if (choices.length === 0 || model.unavailable || model.available === false) {
        setSubmenu(null);
        return;
      }
      const rootHeight = rootRef.current?.offsetHeight ?? 320;
      const listOffset = listRef.current?.offsetTop ?? 36;
      const scrollTop = listRef.current?.scrollTop ?? 0;
      const rawTop = rowEl ? listOffset + rowEl.offsetTop - scrollTop : listOffset;
      const estimatedMenuHeight = choices.length * 32 + 20;
      const clampedTop = Math.max(4, Math.min(rawTop, Math.max(4, rootHeight - estimatedMenuHeight)));
      setSubmenu({ model, top: clampedTop });
    },
    [clearCloseTimer],
  );

  const handlePickEffort = useCallback(
    (targetModel: FlatModel, variant: string | null) => {
      if (sameModel(selected, targetModel)) {
        effort?.onChange(variant);
      } else {
        pendingEffortRef.current = {
          model: { providerID: targetModel.providerID, modelID: targetModel.modelID },
          variant,
        };
        onPick(targetModel);
      }
      setSubmenu(null);
    },
    [selected, effort, onPick],
  );

  const rows = useMemo(() => {
    if (searching) return searchModels;
    if (activeTab === 'all') return browseModels;
    if (activeTab === 'favorites') return favorites;
    return browseModels.filter((m) => pickerTabOf(m) === activeTab);
  }, [searching, searchModels, activeTab, favorites, browseModels]);

  const sections = useMemo(() => [{ id: searching ? 'search' : activeTab, models: rows }], [searching, activeTab, rows]);
  const ordered = useMemo(() => sections.flatMap((s) => s.models), [sections]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === '/' && !showSearchInput) {
      event.preventDefault();
      setSearchOpen(true);
      return;
    }
    if (!(IS_MAC ? event.metaKey : event.ctrlKey) || event.altKey || event.shiftKey) return;
    if (!/^[1-9]$/.test(event.key)) return;
    const model = ordered[Number(event.key) - 1];
    if (!model || model.unavailable) return;
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

  const mixedProviders = activeTab === 'all' && providerTabs.filter((id) => id !== 'favorites').length > 1;

  // Determine active effort submenu choices
  const submenuChoices = useMemo(() => {
    if (!submenu) return [];
    const rawChoices = modelEffortChoices(submenu.model);
    if (rawChoices.length === 0) return [];
    const isAg = isAntigravitySubscriptionModel(submenu.model);
    const items: Array<{ value: string | null; label: string }> = [];
    if (!isAg && !submenu.model.defaultEffort) {
      items.push({ value: null, label: 'Auto' });
    }
    for (const choice of rawChoices) {
      items.push({ value: choice, label: effortLabel(choice) });
    }
    return items;
  }, [submenu]);

  const submenuCurrentEffort = useMemo(() => {
    if (!submenu) return null;
    if (sameModel(selected, submenu.model)) {
      if (effort?.selectedVariant) return effort.selectedVariant;
    }
    return submenu.model.defaultEffort ?? null;
  }, [submenu, selected, effort?.selectedVariant]);

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
            const key = modelKey(model);
            const rowIsSelected = sameModel(selected, model);
            const rowHasSubmenu = submenu ? modelKey(submenu.model) === key : false;
            return (
              <PickerRow
                key={key}
                model={model}
                isSelected={rowIsSelected}
                isSubmenuOpen={rowHasSubmenu}
                showLogo={mixedProviders}
                selectedEffort={rowIsSelected ? (effort?.selectedVariant ?? model.defaultEffort ?? null) : (model.defaultEffort ?? null)}
                favorite={isFavorite(model)}
                onToggleFavorite={(on) => setFavorite(model, on)}
                onSelect={() => {
                  if (model.unavailable) return;
                  onPick(model);
                }}
                onHoverRow={(el) => openSubmenuForRow(model, el)}
                onLeaveRow={scheduleCloseSubmenu}
                onToggleSubmenu={(el) => {
                  if (rowHasSubmenu) setSubmenu(null);
                  else openSubmenuForRow(model, el);
                }}
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
      className="bg-popover relative flex min-w-0 flex-col rounded-xl overflow-visible"
      onKeyDown={onKeyDown}
      onMouseLeave={scheduleCloseSubmenu}
    >
      {/* Clean Top Header ("Model" + subtle Search toggle + optional connect/manage actions) */}
      <div className="flex items-center justify-between gap-2 px-3 pt-2.5 pb-1">
        <span className="text-muted-foreground text-xs font-medium tracking-tight">Model</span>
        <div className="flex items-center gap-0.5">
          {!showSearchInput && (
            <button
              type="button"
              aria-label={t('search')}
              onClick={() => setSearchOpen(true)}
              className="text-muted-foreground hover:text-foreground hover:bg-hover flex size-6 cursor-pointer items-center justify-center rounded-md transition-colors"
            >
              <MagnifyingGlassIcon className="size-3.5" />
            </button>
          )}
          {searchRight}
        </div>
      </div>

      {/* Expandable / multi-catalog Search Input */}
      {showSearchInput ? (
        <div className="border-b border-border/40">
          <CommandInput
            compact
            placeholder={t('search')}
            value={search}
            onValueChange={onSearchChange}
            autoFocus={searchOpen}
          />
        </div>
      ) : null}

      {/* Compact Provider Filter Tabs (hidden when single provider, matching Antigravity) */}
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
                  setSubmenu(null);
                  if (searching) onSearchChange('');
                }}
                onKeyDown={keepKeyOnButton}
                className={cn(
                  'flex h-5.5 shrink-0 cursor-pointer items-center gap-1 rounded-md px-2 text-[11px] font-medium outline-none transition-colors',
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

      {/* Scrollable Model List (zero visible scrollbars) */}
      <CommandList
        ref={listRef}
        className={cn(
          SCROLLBAR_HIDE_CLASS,
          'max-h-[min(19rem,50vh)] min-h-0 flex-1 overflow-y-auto px-1 pb-1',
        )}
      >
        {body}
      </CommandList>

      {/* Inline narrow-screen / inlineMode effort strip for active or expanded model */}
      {effort && effort.choices.length > 0 && (
        <div
          className={cn(
            'border-border/40 bg-muted/15 items-center justify-between gap-1.5 border-t px-2.5 py-1.5 text-xs',
            inlineMode ? 'flex' : 'flex sm:hidden',
          )}
        >
          <span className="shrink-0 text-[11px] font-medium text-muted-foreground">{t('thinking')}</span>
          <div className={cn(SCROLLBAR_HIDE_CLASS, 'flex items-center gap-1 overflow-x-auto')}>
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
      )}

      {/* Bottom "View Usage" Footer Row (matches Antigravity model selector) */}
      {onViewUsage ? (
        <div className="border-t border-border/50 p-1">
          <button
            type="button"
            onClick={onViewUsage}
            onKeyDown={keepKeyOnButton}
            className="text-muted-foreground hover:text-foreground hover:bg-hover flex h-8 w-full cursor-pointer items-center justify-between gap-2 rounded-lg px-2 text-xs font-medium transition-colors outline-none"
          >
            <span className="flex items-center gap-2">
              <GaugeIcon className="size-3.5 shrink-0" />
              <span>View Usage</span>
            </span>
            <CaretRightIcon className="size-3.5 shrink-0 opacity-70" />
          </button>
        </div>
      ) : null}

      {/* Floating Right-Hand Effort Submenu Card (matches Google Antigravity) */}
      {!inlineMode && submenu && submenuChoices.length > 0 ? (
        <div
          role="menu"
          aria-label={`${pickerModelName(submenu.model)} reasoning effort`}
          onMouseEnter={clearCloseTimer}
          onMouseLeave={scheduleCloseSubmenu}
          style={{ top: `${submenu.top}px` }}
          className="hidden sm:block absolute left-full z-50 pl-1.5"
        >
          <div className="bg-popover border-border flex w-40 flex-col gap-0.5 rounded-xl border p-1.5 shadow-2xl">
            {submenuChoices.map((item) => {
              const active =
                item.value === null
                  ? submenuCurrentEffort == null
                  : submenuCurrentEffort === item.value;
              return (
                <button
                  key={item.value ?? '__auto__'}
                  type="button"
                  role="menuitemradio"
                  aria-checked={active}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    handlePickEffort(submenu.model, item.value);
                  }}
                  className={cn(
                    'flex h-8 w-full cursor-pointer items-center justify-between gap-2 rounded-lg px-2.5 text-left text-[13px] transition-colors outline-none',
                    'hover:bg-hover focus-visible:bg-hover',
                    active ? 'text-foreground font-semibold bg-active/70' : 'text-foreground/85 font-normal',
                  )}
                >
                  <span>{item.label}</span>
                  {active ? <CheckIcon className="text-foreground size-3.5 shrink-0" /> : null}
                </button>
              );
            })}
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
  isSubmenuOpen,
  showLogo,
  selectedEffort,
  favorite,
  onToggleFavorite,
  onSelect,
  onHoverRow,
  onLeaveRow,
  onToggleSubmenu,
  connectLabel,
}: {
  model: FlatModel;
  isSelected: boolean;
  isSubmenuOpen: boolean;
  showLogo: boolean;
  selectedEffort: string | null;
  favorite: boolean;
  onToggleFavorite: (on: boolean) => void;
  onSelect: () => void;
  onHoverRow: (el: HTMLElement | null) => void;
  onLeaveRow: () => void;
  onToggleSubmenu: (el: HTMLElement | null) => void;
  shortcut: number | null;
  connectLabel: string;
}) {
  const t = useTranslations('modelSelector');
  const rowRef = useRef<HTMLDivElement>(null);
  const disconnected = model.available === false;
  const unavailable = model.unavailable === true;
  const disabledRow = unavailable;
  const groupID = pickerGroupId(model);
  const displayName = pickerModelName(model);
  const efforts = modelEffortChoices(model);
  const hasEfforts = efforts.length > 0 && !disabledRow && !disconnected;
  const effortText = hasEfforts && selectedEffort ? effortLabel(selectedEffort) : null;

  const badge = model.badge;
  const showInfoOnNew = badge === 'new' && !hasEfforts;

  return (
    <CommandItem
      ref={rowRef}
      value={modelItemValue('model', model)}
      title={model.description || model.modelID}
      disabled={disabledRow}
      onSelect={() => {
        if (disabledRow) return;
        onSelect();
      }}
      onMouseEnter={() => onHoverRow(rowRef.current)}
      onMouseLeave={onLeaveRow}
      className={cn(
        'group h-8 justify-between gap-2 rounded-lg px-2 text-[13px]',
        disabledRow
          ? 'cursor-not-allowed opacity-50 hover:bg-transparent'
          : 'cursor-pointer hover:bg-hover [&:not([data-nav=pointer]_*)]:data-[selected=true]:bg-hover',
        (isSelected || isSubmenuOpen) &&
          !disabledRow &&
          'bg-active [&:not([data-nav=pointer]_*)]:data-[selected=true]:bg-active',
      )}
    >
      <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
        {showLogo ? (
          <ProviderLogo
            providerID={groupID}
            name={pickerGroupLabel(groupID, model)}
            size="xs"
            className="size-3.5 shrink-0 rounded-xs opacity-80"
          />
        ) : null}

        <span
          className={cn(
            'truncate leading-tight',
            disabledRow
              ? 'text-muted-foreground font-normal'
              : isSelected || isSubmenuOpen
                ? 'text-foreground font-semibold'
                : 'text-foreground/90 font-normal group-hover:text-foreground group-hover:font-medium',
          )}
        >
          {displayName}
        </span>

        {effortText ? (
          <span className="text-muted-foreground shrink-0 text-[12px] font-normal">
            {effortText}
          </span>
        ) : null}

        {badge === 'new' && !unavailable ? (
          <span
            className={cn(
              'bg-foreground/12 text-foreground/90 inline-flex h-[18px] shrink-0 items-center gap-1 rounded-full px-2 text-[11px] font-medium leading-none',
            )}
          >
            <span>New</span>
            {showInfoOnNew ? <InfoIcon className="text-muted-foreground size-3 shrink-0" /> : null}
          </span>
        ) : badge === 'notice' && !unavailable ? (
          <span className="bg-foreground/12 text-foreground/90 inline-flex h-[18px] shrink-0 items-center gap-1 rounded-full px-2 text-[11px] font-medium leading-none">
            <span>Notice</span>
            <InfoIcon className="text-muted-foreground size-3 shrink-0" />
          </span>
        ) : badge === 'unavailable' || unavailable ? (
          <span className="bg-foreground/8 text-muted-foreground/70 inline-flex h-[18px] shrink-0 items-center gap-1 rounded-full px-2 text-[11px] font-medium leading-none">
            <span>Unavailable</span>
            <InfoIcon className="size-3 shrink-0 opacity-75" />
          </span>
        ) : disconnected ? (
          <Tag className="px-1.5 py-0 text-[10px]">{connectLabel}</Tag>
        ) : shouldShowFreeTag(model) ? (
          <Tag variant="free" className="px-1.5 py-0 text-[10px]">
            {t('free')}
          </Tag>
        ) : null}
      </div>

      <div className="flex shrink-0 items-center gap-0.5">
        {!disabledRow ? (
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
              'flex size-5 shrink-0 cursor-pointer items-center justify-center rounded transition-opacity',
              favorite
                ? 'text-kortix-orange opacity-100'
                : 'text-muted-foreground hover:text-kortix-orange pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100',
            )}
          >
            <StarIcon weight={favorite ? 'fill' : 'regular'} className="size-3" />
          </button>
        ) : null}

        {hasEfforts ? (
          <button
            type="button"
            aria-label={`Select effort for ${displayName}`}
            onPointerDown={(e) => e.stopPropagation()}
            onKeyDown={keepKeyOnButton}
            onClick={(e) => {
              e.stopPropagation();
              onToggleSubmenu(rowRef.current);
            }}
            className="text-muted-foreground hover:text-foreground flex size-5 shrink-0 cursor-pointer items-center justify-center rounded"
          >
            {isSelected && !isSubmenuOpen ? (
              <>
                <CheckIcon className="text-foreground size-3.5 shrink-0 group-hover:hidden" />
                <CaretRightIcon className="hidden size-3.5 shrink-0 group-hover:block" />
              </>
            ) : (
              <CaretRightIcon className="size-3.5 shrink-0" />
            )}
          </button>
        ) : isSelected ? (
          <CheckIcon className="text-foreground size-3.5 shrink-0" />
        ) : null}
      </div>
    </CommandItem>
  );
}
