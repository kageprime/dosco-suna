'use client';

import type { FlatModel } from '@kortix/sdk/react';
import {
  CaretDownIcon,
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
import { CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from '../../primitives/command';
import Loading from '../../primitives/loading';
import { Tag } from '../../primitives/tag';
import { effortLabel } from '../composer/reasoning-effort-selector';
import {
  buildPickerSections,
  isPickerGroupOpen,
  modelItemValue,
  pickerGroupId,
  pickerGroupLabel,
} from './model-grouping';
import {
  isAntigravitySubscriptionModel,
  isSubscriptionModel,
  pickerModelName,
  shouldShowFreeTag,
} from './model-tags';

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
  subscriptionProvider?: 'codex' | 'claude-agent' | 'antigravity' | null;
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
 * Site-themed Model Picker with inline collapsible provider groups:
 * - Inherits Dosco's site font (`font-sans`) and theme tokens (`bg-popover`, `text-foreground`, `bg-hover`, `bg-active`, `Tag`).
 * - Groups models inline by provider (`Dosco`, `Google Antigravity`, `ChatGPT`, …) instead of a top horizontal switcher bar.
 * - Rows display model name, muted inline effort (`Medium`), theme-matched badges (`New`, `Notice`, `Unavailable`), star favorite toggle, and `✓` / `>` affordance.
 * - Floating right-hand effort submenu (`Low`, `Medium ✓`, `High`, `Extra` / `Auto`) on hover or chevron tap, plus an inline strip on narrow / `inlineMode` panels.
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
  const [toggledGroups, setToggledGroups] = useState<Map<string, boolean>>(() => new Map());
  const [searchOpen, setSearchOpen] = useState(false);

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

  const rows = searching ? searchModels : browseModels;

  const sections = useMemo(() => {
    const groups = new Map<string, { providerID: string; providerName: string; models: FlatModel[] }>();
    for (const model of rows) {
      const groupID = pickerGroupId(model);
      const existing = groups.get(groupID);
      if (existing) {
        existing.models.push(model);
      } else {
        groups.set(groupID, {
          providerID: groupID,
          providerName: pickerGroupLabel(groupID, model),
          models: [model],
        });
      }
    }
    const orderedGroups = Array.from(groups.values()).sort((a, b) => {
      const ai = MODEL_SELECTOR_PROVIDER_IDS.indexOf(a.providerID);
      const bi = MODEL_SELECTOR_PROVIDER_IDS.indexOf(b.providerID);
      if (ai >= 0 && bi < 0) return -1;
      if (ai < 0 && bi >= 0) return 1;
      if (ai >= 0 && bi >= 0) return ai - bi;
      return a.providerName.localeCompare(b.providerName);
    });
    return buildPickerSections(orderedGroups);
  }, [rows]);

  const showChatGptConnect = !searching && !!onConnectChatGpt && !sections.some((s) => s.id === 'chatgpt');
  const collapsibleSections = sections.length > 1;

  const shortcutModels = useMemo(() => {
    const visible: FlatModel[] = [];
    if (!searching && favorites.length > 0) visible.push(...favorites);
    sections.forEach((section, index) => {
      const open =
        !collapsibleSections ||
        isPickerGroupOpen({
          groupIndex: index,
          groupProviderID: section.id,
          hasSearch: searching,
          containsSelected: section.models.some((m) => sameModel(selected, m)),
          totalGroups: sections.length,
          toggled: toggledGroups,
        });
      if (open) visible.push(...section.models);
    });
    return visible;
  }, [searching, favorites, sections, collapsibleSections, selected, toggledGroups]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === '/' && !showSearchInput) {
      event.preventDefault();
      setSearchOpen(true);
      return;
    }
    if (!(IS_MAC ? event.metaKey : event.ctrlKey) || event.altKey || event.shiftKey) return;
    if (!/^[1-9]$/.test(event.key)) return;
    const model = shortcutModels[Number(event.key) - 1];
    if (!model || model.unavailable) return;
    event.preventDefault();
    event.stopPropagation();
    onPick(model);
  };

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

  const renderModelRow = (model: FlatModel, scope: 'pinned' | 'model', keyPrefix: string) => {
    const key = modelKey(model);
    const rowIsSelected = sameModel(selected, model);
    const rowHasSubmenu = submenu ? modelKey(submenu.model) === key : false;
    return (
      <PickerRow
        key={`${keyPrefix}:${key}`}
        model={model}
        scope={scope}
        isSelected={rowIsSelected}
        isSubmenuOpen={rowHasSubmenu}
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
        connectLabel={connectLabel}
      />
    );
  };

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
  } else {
    body = (
      <>
        {!searching && favorites.length > 0 ? (
          <>
            <CommandGroup
              heading={
                <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                  <StarIcon weight="fill" className="size-3 text-kortix-orange" />
                  <span>{t('favorites')}</span>
                </span>
              }
              forceMount
              className="p-0.5"
            >
              {favorites.map((model) => renderModelRow(model, 'pinned', 'fav'))}
            </CommandGroup>
            <CommandSeparator />
          </>
        ) : null}

        {sections.map((section, sectionIndex) => {
          const selectedInSection = section.models.find((m) => sameModel(selected, m));
          const open =
            !collapsibleSections ||
            isPickerGroupOpen({
              groupIndex: sectionIndex,
              groupProviderID: section.id,
              hasSearch: searching,
              containsSelected: !!selectedInSection,
              totalGroups: sections.length,
              toggled: toggledGroups,
            });
          const toggle = () =>
            setToggledGroups((prev) => new Map(prev).set(section.id, !open));

          return (
            <Fragment key={section.id}>
              {sectionIndex > 0 && <CommandSeparator />}
              <CommandGroup forceMount className="p-0.5">
                {collapsibleSections ? (
                  <CommandItem
                    value={`section-${section.id}`}
                    onSelect={toggle}
                    onMouseEnter={() => setSubmenu(null)}
                    className="cursor-pointer py-1.5"
                  >
                    {open ? (
                      <CaretDownIcon className="text-muted-foreground size-3.5 shrink-0" />
                    ) : (
                      <CaretRightIcon className="text-muted-foreground size-3.5 shrink-0" />
                    )}
                    <ProviderLogo
                      providerID={section.providerID}
                      name={section.label}
                      size="xs"
                      className="size-4 shrink-0 rounded-none bg-transparent"
                    />
                    <span className="min-w-0 truncate text-sm font-medium text-foreground">
                      {section.label}
                    </span>
                    <span className="flex-1" />
                    {section.models.some(isSubscriptionModel) ? (
                      <Tag>{t('included')}</Tag>
                    ) : null}
                    {!open && selectedInSection ? (
                      <>
                        <span className="text-muted-foreground min-w-0 truncate text-xs">
                          {pickerModelName(selectedInSection)}
                        </span>
                        <CheckIcon className="text-foreground size-3.5 shrink-0" />
                      </>
                    ) : !open ? (
                      <span className="text-muted-foreground text-xs tabular-nums">
                        {section.models.length}
                      </span>
                    ) : null}
                  </CommandItem>
                ) : null}

                {open
                  ? section.models.map((model) => renderModelRow(model, 'model', section.id))
                  : null}
              </CommandGroup>
            </Fragment>
          );
        })}

        {showChatGptConnect ? (
          <>
            {sections.length > 0 && <CommandSeparator />}
            <CommandGroup forceMount className="p-0.5">
              <CommandItem
                value="connect-chatgpt"
                onSelect={onConnectChatGpt}
                onMouseEnter={() => setSubmenu(null)}
                className="cursor-pointer justify-between gap-2 py-1.5 text-sm"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <ProviderLogo
                    providerID="chatgpt"
                    name="ChatGPT"
                    size="xs"
                    className="size-4 shrink-0 rounded-none bg-transparent"
                  />
                  <span className="truncate font-medium text-foreground">ChatGPT</span>
                </span>
                <Tag>{tPooled('connectChatGpt')}</Tag>
              </CommandItem>
            </CommandGroup>
          </>
        ) : null}
      </>
    );
  }

  return (
    <div
      ref={rootRef}
      className="bg-popover text-popover-foreground relative flex min-w-0 flex-col overflow-visible rounded-lg font-sans"
      onKeyDown={onKeyDown}
      onMouseLeave={scheduleCloseSubmenu}
    >
      {/* Clean Header ("Model" + subtle Search toggle + optional connect/manage actions) */}
      <div className="flex items-center justify-between gap-2 px-3 pt-2.5 pb-1">
        <span className="text-muted-foreground text-xs font-medium tracking-tight">Model</span>
        <div className="flex items-center gap-0.5">
          {!showSearchInput && (
            <button
              type="button"
              aria-label={t('search')}
              onClick={() => setSearchOpen(true)}
              className="text-muted-foreground hover:bg-hover hover:text-foreground flex size-6 cursor-pointer items-center justify-center rounded-md transition-colors"
            >
              <MagnifyingGlassIcon className="size-3.5" />
            </button>
          )}
          {searchRight}
        </div>
      </div>

      {/* Expandable / multi-catalog Search Input */}
      {showSearchInput ? (
        <div className="border-border/60 border-b">
          <CommandInput
            compact
            placeholder={t('search')}
            value={search}
            onValueChange={onSearchChange}
            autoFocus={searchOpen}
          />
        </div>
      ) : null}

      {/* Scrollable Inline Provider Groups (zero visible scrollbars) */}
      <CommandList
        ref={listRef}
        className={cn(
          SCROLLBAR_HIDE_CLASS,
          'max-h-[min(22rem,55vh)] min-h-0 flex-1 overflow-y-auto px-1 py-1',
        )}
      >
        {body}
      </CommandList>

      {/* Inline narrow-screen / inlineMode effort strip */}
      {effort && effort.choices.length > 0 && (
        <div
          className={cn(
            'border-border/60 items-center justify-between gap-1.5 border-t px-2.5 py-1.5 text-xs',
            inlineMode ? 'flex' : 'flex sm:hidden',
          )}
        >
          <span className="text-muted-foreground shrink-0 text-xs font-medium">{t('thinking')}</span>
          <div className={cn(SCROLLBAR_HIDE_CLASS, 'flex items-center gap-1 overflow-x-auto')}>
            <button
              type="button"
              onClick={() => effort.onChange(null)}
              className={cn(
                'h-6 shrink-0 cursor-pointer rounded-md px-2 text-xs transition-colors outline-none',
                effort.selectedVariant == null
                  ? 'bg-active text-foreground font-medium'
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
                  'h-6 shrink-0 cursor-pointer rounded-md px-2 text-xs capitalize transition-colors outline-none',
                  effort.selectedVariant === choice
                    ? 'bg-active text-foreground font-medium'
                    : 'text-muted-foreground hover:bg-hover hover:text-foreground',
                )}
              >
                {effortLabel(choice)}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Bottom "View Usage" Footer Row */}
      {onViewUsage ? (
        <div className="border-border/60 border-t p-1">
          <button
            type="button"
            onClick={onViewUsage}
            onKeyDown={keepKeyOnButton}
            className="text-muted-foreground hover:bg-hover hover:text-foreground flex h-8 w-full cursor-pointer items-center justify-between gap-2 rounded-md px-2 text-xs font-medium transition-colors outline-none"
          >
            <span className="flex items-center gap-2">
              <GaugeIcon className="size-3.5 shrink-0" />
              <span>View Usage</span>
            </span>
            <CaretRightIcon className="size-3.5 shrink-0 opacity-70" />
          </button>
        </div>
      ) : null}

      {/* Floating Right-Hand Effort Submenu Card (site theme tokens + font) */}
      {!inlineMode && submenu && submenuChoices.length > 0 ? (
        <div
          role="menu"
          aria-label={`${pickerModelName(submenu.model)} reasoning effort`}
          onMouseEnter={clearCloseTimer}
          onMouseLeave={scheduleCloseSubmenu}
          style={{ top: `${submenu.top}px` }}
          className="absolute left-full z-50 hidden pl-1.5 sm:block"
        >
          <div className="bg-popover text-popover-foreground border-border flex w-40 flex-col gap-0.5 rounded-lg border p-1 shadow-md">
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
                    'flex h-8 w-full cursor-pointer items-center justify-between gap-2 rounded-md px-2.5 text-left text-sm transition-colors outline-none',
                    'hover:bg-hover focus-visible:bg-hover',
                    active ? 'bg-active text-foreground font-medium' : 'text-foreground font-normal',
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
  scope,
  isSelected,
  isSubmenuOpen,
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
  scope: 'pinned' | 'model';
  isSelected: boolean;
  isSubmenuOpen: boolean;
  selectedEffort: string | null;
  favorite: boolean;
  onToggleFavorite: (on: boolean) => void;
  onSelect: () => void;
  onHoverRow: (el: HTMLElement | null) => void;
  onLeaveRow: () => void;
  onToggleSubmenu: (el: HTMLElement | null) => void;
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
      value={modelItemValue(scope, model)}
      title={model.description || model.modelID}
      disabled={disabledRow}
      onSelect={() => {
        if (disabledRow) return;
        onSelect();
      }}
      onMouseEnter={() => onHoverRow(rowRef.current)}
      onMouseLeave={onLeaveRow}
      className={cn(
        'group h-8 justify-between gap-2 rounded-md px-2 text-sm',
        disabledRow
          ? 'cursor-not-allowed opacity-50 hover:bg-transparent'
          : 'cursor-pointer hover:bg-hover [&:not([data-nav=pointer]_*)]:data-[selected=true]:bg-hover',
        (isSelected || isSubmenuOpen) &&
          !disabledRow &&
          'bg-active [&:not([data-nav=pointer]_*)]:data-[selected=true]:bg-active',
      )}
    >
      <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
        <ProviderLogo
          providerID={groupID}
          name={pickerGroupLabel(groupID, model)}
          size="xs"
          className="size-4 shrink-0 rounded-none bg-transparent opacity-85"
        />

        <span
          className={cn(
            'truncate leading-tight',
            disabledRow
              ? 'text-muted-foreground font-normal'
              : isSelected || isSubmenuOpen
                ? 'text-foreground font-medium'
                : 'text-foreground font-normal',
          )}
        >
          {displayName}
        </span>

        {effortText ? (
          <span className="text-muted-foreground shrink-0 text-xs font-normal">
            {effortText}
          </span>
        ) : null}

        {badge === 'new' && !unavailable ? (
          <span className="bg-kortix-orange/15 text-foreground inline-flex h-5 shrink-0 items-center gap-1 rounded-sm px-1.5 text-xs font-medium leading-none">
            <span>New</span>
            {showInfoOnNew ? <InfoIcon className="text-kortix-orange size-3 shrink-0" /> : null}
          </span>
        ) : badge === 'notice' && !unavailable ? (
          <span className="bg-kortix-blue/15 text-foreground inline-flex h-5 shrink-0 items-center gap-1 rounded-sm px-1.5 text-xs font-medium leading-none">
            <span>Notice</span>
            <InfoIcon className="text-kortix-blue size-3 shrink-0" />
          </span>
        ) : badge === 'unavailable' || unavailable ? (
          <Tag>Unavailable</Tag>
        ) : disconnected ? (
          <Tag>{connectLabel}</Tag>
        ) : shouldShowFreeTag(model) ? (
          <Tag variant="free">{t('free')}</Tag>
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
