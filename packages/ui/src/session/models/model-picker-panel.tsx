'use client';

import type { FlatModel } from '@kortix/sdk/react';
import { ArrowLeftIcon, CaretRightIcon, StarIcon } from '@phosphor-icons/react';
import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

import { useTranslations } from '../../i18n';
import { SolidCheckIcon } from '../../internal/icons/solid-check-icon';
import { MODEL_SELECTOR_PROVIDER_IDS, ProviderLogo } from '../../internal/lib/provider-branding';
import { cn } from '../../lib/utils';
import { foreignDialogOpen, openDialogs } from '../../lib/z-stack';
import { Button } from '../../primitives/button';
import { CommandGroup, CommandInput, CommandItem, CommandList } from '../../primitives/command';
import Loading from '../../primitives/loading';
import { Tag } from '../../primitives/tag';
import { effortLabel, ReasoningEffortPane } from '../composer/reasoning-effort-selector';
import { curatePrimaryModels, modelSubtitle, type ModelSubtitleStrings } from './model-curation';
import {
  modelItemValue,
  pickerGroupId,
  pickerGroupLabel,
  pickerTabOf,
  pickerTabs,
  type PickerTabId,
} from './model-grouping';
import { isSubscriptionModel, pickerModelName, shouldShowFreeTag } from './model-tags';
import { SubscriptionFooterButton, SubscriptionSwitcher } from './subscription-switcher';

type ModelRef = { providerID: string; modelID: string };
type PickerView = 'primary' | 'more' | 'effort' | 'account';
type BrowseFilter = 'all' | PickerTabId;

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform);

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
  /** Thinking effort for the selected model. Absent = no Thinking footer row. */
  effort?: {
    choices: readonly string[];
    selectedVariant: string | null | undefined;
    onChange: (variant: string | null) => void;
  };
}

/**
 * Progressive-disclosure composer model popover:
 * - Default (`primary`): curated 2-line rows with clean descriptions, inline badges,
 *   and footer rows for Thinking effort, Subscription account (when applicable),
 *   and More models.
 * - `effort` / `account` / `more`: compact single-column drill-down sub-views.
 *
 * Mod + 1..9 remains available for quick keyboard selection on visible rows.
 */
export function ModelPickerPanel({
  browseModels,
  pickableModels,
  searchModels,
  search,
  onSearchChange,
  searchRight,
  selected,
  accountDefault,
  onPick,
  isFavorite,
  setFavorite,
  loading,
  emptyState,
  searchEmpty,
  onConnectChatGpt,
  connectLabel,
  subscriptionProvider,
  onUpgrade,
  effort,
  onForeignDialog,
}: ModelPickerPanelProps) {
  const t = useTranslations('modelSelector');
  const tThreads = useTranslations('threads');
  const tPooled = useTranslations('pooledSecrets');

  const [view, setView] = useState<PickerView>('primary');
  const [browseFilter, setBrowseFilter] = useState<BrowseFilter>('all');

  const favorites = useMemo(() => pickableModels.filter(isFavorite), [pickableModels, isFavorite]);
  const tabs = useMemo(
    () =>
      pickerTabs(browseModels, {
        canConnectChatGpt: !!onConnectChatGpt,
        providerOrder: MODEL_SELECTOR_PROVIDER_IDS,
      }),
    [browseModels, onConnectChatGpt],
  );

  const curatedModels = useMemo(
    () =>
      curatePrimaryModels({
        browseModels,
        pickableModels,
        selected,
        accountDefault,
        isFavorite,
      }),
    [browseModels, pickableModels, selected, accountDefault, isFavorite],
  );

  const subtitleStrings: ModelSubtitleStrings = useMemo(
    () => ({
      freeFast: t('subtitle.freeFast'),
      freeGeneral: t('subtitle.freeGeneral'),
      reasoning: t('subtitle.reasoning'),
      fast: t('subtitle.fast'),
      balanced: t('subtitle.balanced'),
      general: t('subtitle.general'),
    }),
    [t],
  );

  // Typing immediately moves into `more` view if not already there.
  const searching = search.trim().length > 0;
  const activeView: PickerView = searching ? 'more' : view;

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

  const browseRows = useMemo(() => {
    if (searching) return searchModels;
    if (browseFilter === 'all') return browseModels;
    if (browseFilter === 'favorites') return favorites;
    return browseModels.filter((m) => pickerTabOf(m) === browseFilter);
  }, [searching, searchModels, browseFilter, browseModels, favorites]);

  const visibleShortcutModels = activeView === 'primary' ? curatedModels : activeView === 'more' ? browseRows : [];

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!(IS_MAC ? event.metaKey : event.ctrlKey) || event.altKey || event.shiftKey) return;
    if (!/^[1-9]$/.test(event.key)) return;
    const model = visibleShortcutModels[Number(event.key) - 1];
    if (!model) return;
    event.preventDefault();
    event.stopPropagation();
    onPick(model);
  };

  const tabLabel = (id: BrowseFilter) => {
    if (id === 'all') return t('allModels');
    if (id === 'favorites') return t('favorites');
    if (id === 'kortix') return 'Dosco';
    if (id === 'chatgpt') return 'ChatGPT';
    const sample = browseModels.find((m) => pickerTabOf(m) === id);
    return sample ? pickerGroupLabel(id, sample) : id;
  };

  const hasMoreModels =
    browseModels.length > curatedModels.length ||
    pickableModels.length > curatedModels.length ||
    !!searchRight ||
    !!onConnectChatGpt;

  const hasEffort = !!effort && effort.choices.length > 0;
  const currentEffortText =
    effort?.selectedVariant && effort.choices.includes(effort.selectedVariant)
      ? effortLabel(effort.selectedVariant)
      : tThreads('auto');

  if (activeView === 'effort' && hasEffort) {
    return (
      <div ref={rootRef} className="bg-popover flex min-w-0 flex-col p-1.5" onKeyDown={onKeyDown}>
        <SubViewHeader
          title={t('effort')}
          backLabel={t('back')}
          onBack={() => setView('primary')}
        />
        <ReasoningEffortPane
          hideHeader
          choices={effort.choices}
          selectedVariant={effort.selectedVariant}
          onVariantChange={(variant) => {
            effort.onChange(variant);
            setView('primary');
          }}
        />
      </div>
    );
  }

  if (activeView === 'account' && subscriptionProvider) {
    return (
      <div ref={rootRef} className="bg-popover flex min-w-0 flex-col" onKeyDown={onKeyDown}>
        <SubViewHeader
          title={t('account')}
          backLabel={t('back')}
          onBack={() => setView('primary')}
        />
        <SubscriptionSwitcher providerId={subscriptionProvider} hideHeader />
      </div>
    );
  }

  if (activeView === 'more') {
    const filterItems: BrowseFilter[] = tabs.length > 1 ? ['all', ...tabs] : [];
    const backButton = (
      <button
        type="button"
        aria-label={t('back')}
        onClick={() => {
          if (searching) onSearchChange('');
          setView('primary');
        }}
        onKeyDown={keepKeyOnButton}
        className="text-muted-foreground hover:bg-hover hover:text-foreground focus-visible:ring-ring flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-sm outline-none focus-visible:ring-2"
      >
        <ArrowLeftIcon className="size-4" />
      </button>
    );

    let moreBody: ReactNode;
    if (loading) {
      moreBody = (
        <div className="flex min-h-40 items-center justify-center" role="status" aria-label={t('loading')}>
          <Loading className="text-muted-foreground size-4 shrink-0" />
        </div>
      );
    } else if (searching && browseRows.length === 0) {
      moreBody = searchEmpty;
    } else if (!searching && browseRows.length === 0 && browseFilter === 'favorites') {
      moreBody = <p className="text-muted-foreground px-3 py-8 text-center text-sm">{t('favoritesEmpty')}</p>;
    } else if (!searching && browseRows.length === 0 && browseFilter === 'chatgpt' && onConnectChatGpt) {
      moreBody = (
        <div className="flex justify-center px-3 py-8">
          <Button type="button" size="sm" variant="outline" onClick={onConnectChatGpt}>
            {tPooled('connectChatGpt')}
          </Button>
        </div>
      );
    } else if (browseRows.length === 0) {
      moreBody = emptyState;
    } else {
      moreBody = (
        <CommandGroup forceMount>
          {browseRows.map((model) => (
            <BrowseModelRow
              key={`${model.providerID}:${model.modelID}`}
              model={model}
              isSelected={sameModel(selected, model)}
              favorite={isFavorite(model)}
              onToggleFavorite={(on) => setFavorite(model, on)}
              onSelect={() => onPick(model)}
              connectLabel={connectLabel}
            />
          ))}
        </CommandGroup>
      );
    }

    return (
      <div ref={rootRef} className="bg-popover flex min-w-0 flex-col" onKeyDown={onKeyDown}>
        <CommandInput
          compact
          autoFocus
          placeholder={t('search')}
          value={search}
          onValueChange={onSearchChange}
          leftElement={backButton}
          rightElement={searchRight}
        />
        {!searching && filterItems.length > 0 ? (
          <div
            role="tablist"
            aria-label={t('groups')}
            className="border-border flex items-center gap-1 overflow-x-auto border-b px-2 py-1.5"
          >
            {filterItems.map((id) => {
              const active = id === browseFilter;
              return (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setBrowseFilter(id)}
                  onKeyDown={keepKeyOnButton}
                  className={cn(
                    'flex h-6 shrink-0 cursor-pointer items-center gap-1.5 rounded-sm px-2 text-xs font-medium outline-none',
                    'focus-visible:ring-ring focus-visible:ring-2',
                    active
                      ? 'bg-active text-foreground'
                      : 'text-muted-foreground hover:bg-hover hover:text-foreground',
                  )}
                >
                  {id === 'favorites' ? (
                    <StarIcon weight="fill" className="text-kortix-orange size-3" />
                  ) : null}
                  <span>{tabLabel(id)}</span>
                </button>
              );
            })}
          </div>
        ) : null}
        <CommandList className="max-h-[min(19rem,50vh)] min-h-36">{moreBody}</CommandList>
      </div>
    );
  }

  // Primary view
  if (loading) {
    return (
      <div
        ref={rootRef}
        className="bg-popover flex min-h-36 items-center justify-center"
        role="status"
        aria-label={t('loading')}
        onKeyDown={onKeyDown}
      >
        <Loading className="text-muted-foreground size-4 shrink-0" />
      </div>
    );
  }

  if (curatedModels.length === 0) {
    return (
      <div ref={rootRef} className="bg-popover flex min-w-0 flex-col" onKeyDown={onKeyDown}>
        {emptyState}
      </div>
    );
  }

  const showNavFooter = hasEffort || !!subscriptionProvider || hasMoreModels;

  return (
    <div ref={rootRef} className="bg-popover flex min-w-0 flex-col p-1.5" onKeyDown={onKeyDown}>
      <CommandList className="max-h-[min(22rem,55vh)]">
        <CommandGroup forceMount className="flex flex-col gap-0.5">
          {curatedModels.map((model) => (
            <PrimaryModelRow
              key={`${model.providerID}:${model.modelID}`}
              model={model}
              subtitle={modelSubtitle(model, subtitleStrings)}
              isSelected={sameModel(selected, model)}
              onSelect={() => onPick(model)}
              connectLabel={connectLabel}
              onUpgrade={onUpgrade}
            />
          ))}
        </CommandGroup>
      </CommandList>

      {showNavFooter ? (
        <div className="flex flex-col pt-0.5">
          {hasEffort ? (
            <>
              <div className="border-border/40 my-1 border-t" />
              <button
                type="button"
                onClick={() => setView('effort')}
                onKeyDown={keepKeyOnButton}
                className="text-foreground hover:bg-hover focus-visible:bg-hover focus-visible:ring-ring flex h-9 w-full cursor-pointer items-center justify-between gap-2 rounded-md px-3 text-sm font-medium outline-none transition-colors duration-normal focus-visible:ring-2"
              >
                <span className="truncate">{t('effort')}</span>
                <span className="text-muted-foreground flex shrink-0 items-center gap-1 text-sm font-normal">
                  <span>{currentEffortText}</span>
                  <CaretRightIcon className="size-3.5 shrink-0" />
                </span>
              </button>
            </>
          ) : null}

          {subscriptionProvider ? (
            <>
              <div className="border-border/40 my-1 border-t" />
              <SubscriptionFooterButton
                providerId={subscriptionProvider}
                label={t('account')}
                onOpen={() => setView('account')}
              />
            </>
          ) : null}

          {hasMoreModels ? (
            <>
              <div className="border-border/40 my-1 border-t" />
              <button
                type="button"
                onClick={() => {
                  setBrowseFilter('all');
                  setView('more');
                }}
                onKeyDown={keepKeyOnButton}
                className="text-foreground hover:bg-hover focus-visible:bg-hover focus-visible:ring-ring flex h-9 w-full cursor-pointer items-center justify-between gap-2 rounded-md px-3 text-sm font-medium outline-none transition-colors duration-normal focus-visible:ring-2"
              >
                <span className="truncate">{t('moreModels')}</span>
                <CaretRightIcon className="text-muted-foreground size-3.5 shrink-0" />
              </button>
            </>
          ) : null}
        </div>
      ) : null}

      <div className="border-border/40 my-1 border-t" />
      <div className="text-muted-foreground flex items-center justify-between gap-2 px-3 py-2 text-xs leading-relaxed">
        <span className="min-w-0 truncate">{t('upgradeNote')}</span>
        {onUpgrade ? (
          <button
            type="button"
            onClick={onUpgrade}
            className="text-foreground cursor-pointer shrink-0 font-medium hover:underline"
          >
            {t('learnMore')}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function SubViewHeader({
  title,
  backLabel,
  onBack,
}: {
  title: string;
  backLabel: string;
  onBack: () => void;
}) {
  return (
    <div className="border-border/40 flex h-9 shrink-0 items-center gap-1.5 border-b px-1.5 pb-1">
      <button
        type="button"
        aria-label={backLabel}
        onClick={onBack}
        onKeyDown={keepKeyOnButton}
        className="text-muted-foreground hover:bg-hover hover:text-foreground focus-visible:ring-ring flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md outline-none focus-visible:ring-2"
      >
        <ArrowLeftIcon className="size-4" />
      </button>
      <span className="text-foreground min-w-0 truncate text-sm font-medium">{title}</span>
    </div>
  );
}

function PrimaryModelRow({
  model,
  subtitle,
  isSelected,
  onSelect,
  connectLabel,
  onUpgrade,
}: {
  model: FlatModel;
  subtitle: string;
  isSelected: boolean;
  onSelect: () => void;
  connectLabel: string;
  onUpgrade?: () => void;
}) {
  const t = useTranslations('modelSelector');
  const isUnavailable = model.available === false || model.unavailable === true;
  const isFree = shouldShowFreeTag(model);
  const isSubscription = isSubscriptionModel(model);
  const displayName = pickerModelName(model);

  let badge: ReactNode = null;
  if (isUnavailable) {
    badge = <Tag>{connectLabel}</Tag>;
  } else if (isFree) {
    badge = <Tag variant="free">{t('free')}</Tag>;
  } else if (isSubscription) {
    badge = <Tag>{t('included')}</Tag>;
  }

  return (
    <CommandItem
      value={modelItemValue('model', model)}
      title={model.modelID}
      onSelect={onSelect}
      className={cn(
        'group min-h-12 items-center gap-2 rounded-md px-3 py-2 cursor-pointer duration-normal transition-colors',
        'hover:bg-hover [&:not([data-nav=pointer]_*)]:data-[selected=true]:bg-hover',
        isSelected && 'bg-active [&:not([data-nav=pointer]_*)]:data-[selected=true]:bg-active',
      )}
    >
      <div className={cn('min-w-0 flex-1', isUnavailable && 'opacity-60')}>
        <div className="flex min-w-0 items-center gap-2">
          <span className="text-foreground truncate text-sm font-medium leading-tight">
            {displayName}
          </span>
          {badge}
        </div>
        <p className="text-muted-foreground mt-0.5 truncate text-xs leading-snug">{subtitle}</p>
      </div>

      <span className="flex size-5 shrink-0 items-center justify-end">
        {isUnavailable && onUpgrade ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onUpgrade();
            }}
            className="text-primary hover:text-primary/80 cursor-pointer text-xs font-semibold hover:underline"
          >
            {t('upgrade')}
          </button>
        ) : isSelected ? (
          <SolidCheckIcon className="size-4 shrink-0 text-ring" />
        ) : null}
      </span>
    </CommandItem>
  );
}

function BrowseModelRow({
  model,
  isSelected,
  favorite,
  onToggleFavorite,
  onSelect,
  connectLabel,
}: {
  model: FlatModel;
  isSelected: boolean;
  favorite: boolean;
  onToggleFavorite: (on: boolean) => void;
  onSelect: () => void;
  connectLabel: string;
}) {
  const t = useTranslations('modelSelector');
  const unavailable = model.available === false;
  const isDisabled = unavailable || model.unavailable === true;
  const groupID = pickerGroupId(model);
  const displayName = pickerModelName(model);

  return (
    <CommandItem
      value={modelItemValue('model', model)}
      title={model.modelID}
      onSelect={onSelect}
      className={cn(
        'group h-9 gap-2 rounded-sm',
        'hover:bg-hover [&:not([data-nav=pointer]_*)]:data-[selected=true]:bg-hover',
        isSelected && 'bg-active [&:not([data-nav=pointer]_*)]:data-[selected=true]:bg-active',
      )}
    >
      <ProviderLogo
        providerID={groupID}
        name={pickerGroupLabel(groupID, model)}
        size="xs"
        className="size-4 shrink-0"
      />
      <span className={cn('flex min-w-0 flex-1 items-center gap-1.5 truncate', isDisabled && 'opacity-50')}>
        <span className="text-foreground truncate font-medium">{displayName}</span>
        {model.defaultEffort ? (
          <span className="text-muted-foreground shrink-0 text-xs">{effortLabel(model.defaultEffort)}</span>
        ) : null}
      </span>

      {unavailable ? (
        <Tag>{connectLabel}</Tag>
      ) : shouldShowFreeTag(model) ? (
        <Tag variant="free">{t('free')}</Tag>
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
          'flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-sm',
          'text-muted-foreground hover:text-kortix-orange hover:bg-hover',
          'focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none',
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

      <span className="flex size-4 shrink-0 items-center justify-center">
        {isSelected ? <SolidCheckIcon className="text-ring size-3.5" /> : null}
      </span>
    </CommandItem>
  );
}

/**
 * Enter and Space activate the focused button. cmdk handles both on its root
 * and would select the highlighted model row instead, so they stop here; the
 * browser's own activation still runs. Escape and Mod+digit still bubble.
 */
function keepKeyOnButton(event: KeyboardEvent<HTMLButtonElement>) {
  if (event.key === 'Enter' || event.key === ' ') event.stopPropagation();
}

export { Fragment };
