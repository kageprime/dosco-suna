'use client';

import { CaretDownIcon, CheckIcon, UsersThreeIcon, XIcon } from '@phosphor-icons/react';
import { useId, useMemo, useRef, useState, type ReactNode } from 'react';

import { Copy } from '../icons/copy';
import { cn } from '../lib/utils';
import { Button } from '../primitives/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '../primitives/dropdown-menu';
import { inputSurfaceClasses, inputTransitionClasses } from '../primitives/input';
import Loading from '../primitives/loading';
import { menuRow } from '../primitives/menu-recipe';
import { Popover, PopoverAnchor, PopoverContent } from '../primitives/popover';
import { UserAvatar } from '../primitives/user-avatar';

/*
 * The share dialog's parts: a space and a session share through the same
 * layout (design-system skill, "Grouped rows" and "Composition"). One group is
 * ONE bordered container with hairlines between rows; every row has the same
 * inset (px-3), leading slot (size-8), height (min-h-14) and trailing edge.
 */
export const SHARE_GROUP = 'divide-border border-border divide-y rounded-md border';
export const SHARE_ROW = 'flex min-h-14 items-center gap-3 px-3 py-2';
const SECTION_LABEL = 'text-muted-foreground text-xs font-medium';
/** A text button in the trailing slot: its label, not its padding, ends on the row's edge. */
const TRAILING_BUTTON = 'text-muted-foreground hover:text-foreground -mr-2.5 gap-1';

/** Someone or something that can be given access. */
export interface ShareCandidate {
  id: string;
  kind: 'member' | 'group';
  /** A person's name or email; a group's name. */
  label: string;
  /** Under the label: a named person's email, a group's member count. */
  sublabel?: string | null;
  /** A person's email: matched when one is typed or pasted. */
  email?: string | null;
  avatarUrl?: string | null;
}

function CandidateAvatar({ candidate, size }: { candidate: ShareCandidate; size: 'xs' | 'sm' | 'md' }) {
  if (candidate.kind === 'group') {
    const box = { xs: 'size-5', sm: 'size-6', md: 'size-8' }[size];
    return (
      <span className={cn('bg-muted text-muted-foreground flex shrink-0 items-center justify-center rounded-sm', box)}>
        <UsersThreeIcon className={size === 'md' ? 'size-4' : 'size-3'} />
      </span>
    );
  }
  return (
    <UserAvatar
      email={candidate.email || candidate.id}
      name={candidate.label}
      avatarUrl={candidate.avatarUrl}
      colorKey={candidate.id}
      size={size}
    />
  );
}

/** A labelled section: the label above one group of rows. */
export function ShareSection({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className={SECTION_LABEL}>{label}</h3>
      {children}
    </section>
  );
}

/** One row with access: picture or group tile, name over meta, and the trailing slot. */
export function ShareRow({ candidate, trailing }: { candidate: ShareCandidate; trailing: ReactNode }) {
  return (
    <li className={SHARE_ROW}>
      <CandidateAvatar candidate={candidate} size="md" />
      <div className="min-w-0 flex-1">
        <p className="text-foreground truncate text-sm leading-tight">{candidate.label}</p>
        {candidate.sublabel ? <p className="text-muted-foreground truncate text-xs leading-tight">{candidate.sublabel}</p> : null}
      </div>
      <div className="flex shrink-0 items-center">{trailing}</div>
    </li>
  );
}

/** The trailing role word of a row that cannot change ("Owner"). */
export function ShareRole({ children }: { children: ReactNode }) {
  return <span className="text-muted-foreground text-sm">{children}</span>;
}

/** The trailing role menu of a row that can be removed: "Member ▾" → Remove. */
export function ShareRoleMenu({
  label,
  removeLabel,
  removeIcon,
  onRemove,
  disabled,
}: {
  label: ReactNode;
  removeLabel: ReactNode;
  removeIcon: ReactNode;
  onRemove: () => void;
  disabled?: boolean;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className={TRAILING_BUTTON} disabled={disabled}>
          {label}
          <CaretDownIcon className="size-3 shrink-0" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuItem variant="destructive" className="cursor-pointer" onSelect={onRemove}>
          {removeIcon}
          {removeLabel}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** General access: one row, the current choice on the left, "Change ▾" on the right. */
export function ShareGeneralAccess<T extends string>({
  value,
  options,
  onChange,
  changeLabel,
  disabled,
}: {
  value: T;
  options: ReadonlyArray<{
    value: T;
    label: string;
    hint: string;
    icon: ReactNode;
    disabled?: boolean;
  }>;
  onChange: (next: T) => void;
  changeLabel: ReactNode;
  disabled?: boolean;
}) {
  const current = options.find((option) => option.value === value) ?? options[0]!;
  return (
    <div className={SHARE_GROUP}>
      <div className={SHARE_ROW}>
        <span className="bg-muted text-muted-foreground flex size-8 shrink-0 items-center justify-center rounded-md [&_svg]:size-4">
          {current.icon}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-foreground truncate text-sm leading-tight">{current.label}</p>
          <p className="text-muted-foreground truncate text-xs leading-tight">{current.hint}</p>
        </div>
        {disabled ? null : (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className={TRAILING_BUTTON}>
                {changeLabel}
                <CaretDownIcon className="size-3 shrink-0" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-60">
              <DropdownMenuRadioGroup value={value} onValueChange={(next) => next !== value && onChange(next as T)}>
                {options.map((option) => (
                  <DropdownMenuRadioItem key={option.value} value={option.value} disabled={option.disabled} className="cursor-pointer">
                    {option.label}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </div>
  );
}

/** The thing's link in a muted field, with Copy link one inset from three edges. */
export function ShareLinkField({ link, copyLabel, onCopy }: { link: string; copyLabel: ReactNode; onCopy: () => void }) {
  return (
    <div className="bg-muted/50 border-border flex h-10 items-center gap-2 rounded-md border p-1 pl-3">
      <span className="text-muted-foreground min-w-0 flex-1 truncate text-sm">{link}</span>
      <Button type="button" size="sm" variant="outline" className="bg-background h-full shrink-0 gap-1.5" onClick={onCopy}>
        <Copy className="size-3.5 shrink-0" />
        {copyLabel}
      </Button>
    </div>
  );
}

/**
 * Add people (and groups): a multi-select field and a Share button of one
 * height. Focus lists everyone who can still be added; typing narrows it;
 * picking stages a chip; pasting or typing emails (comma, space or newline
 * separated) stages every member they match. Share hands the whole set over.
 */
export function ShareAddField({
  candidates,
  excludeIds,
  onShare,
  pending,
  disabled,
  placeholder,
  shareLabel,
  removeLabel,
  onUnknownEmails,
}: {
  candidates: readonly ShareCandidate[];
  /** Already have access: never offered. */
  excludeIds: ReadonlySet<string>;
  /** Resolves true when the share saved; the field then clears. */
  onShare: (picked: ShareCandidate[]) => Promise<boolean>;
  pending: boolean;
  disabled: boolean;
  placeholder: string;
  shareLabel: ReactNode;
  removeLabel: string;
  /** Emails typed or pasted that match nobody who can be added. */
  onUnknownEmails: (emails: string[]) => void;
}) {
  const inputId = useId();
  const [query, setQuery] = useState('');
  const [staged, setStaged] = useState<ShareCandidate[]>([]);
  const [focused, setFocused] = useState(false);
  const fieldRef = useRef<HTMLDivElement>(null);

  const stagedIds = useMemo(() => new Set(staged.map((candidate) => candidate.id)), [staged]);
  const byEmail = useMemo(
    () => new Map(candidates.filter((candidate) => candidate.email).map((candidate) => [candidate.email!.toLowerCase(), candidate])),
    [candidates],
  );
  const needle = query.trim().toLowerCase();
  // Everyone is listed; typing only searches. Who already has access or is
  // picked shows a check and cannot be added twice.
  const suggestions = useMemo(
    () =>
      needle
        ? candidates.filter(
            (candidate) => candidate.label.toLowerCase().includes(needle) || candidate.email?.toLowerCase().includes(needle),
          )
        : candidates,
    [candidates, needle],
  );
  const addable = suggestions.filter((candidate) => !excludeIds.has(candidate.id) && !stagedIds.has(candidate.id));

  const stage = (picked: ShareCandidate[]) => {
    setStaged((current) => [...current, ...picked.filter((candidate) => !current.some((other) => other.id === candidate.id))]);
    setQuery('');
  };

  /** Every email in `text` that matches someone who can be added; the rest come back. */
  const resolveEmails = (text: string): { found: ShareCandidate[]; unknown: string[] } => {
    const found: ShareCandidate[] = [];
    const unknown: string[] = [];
    for (const raw of text.split(/[\s,;]+/)) {
      const email = raw.trim().toLowerCase();
      if (!email) continue;
      const candidate = byEmail.get(email);
      if (!candidate) unknown.push(email);
      else if (!excludeIds.has(candidate.id)) found.push(candidate);
    }
    return { found, unknown };
  };

  const submit = async () => {
    let picked = [...staged];
    if (needle) {
      if (!needle.includes('@') && addable.length === 1) picked.push(addable[0]!);
      else {
        const { found, unknown } = resolveEmails(needle);
        if (unknown.length) {
          onUnknownEmails(unknown);
          return;
        }
        picked = [...picked, ...found];
      }
    }
    picked = picked.filter((candidate, index) => picked.findIndex((other) => other.id === candidate.id) === index);
    if (picked.length === 0) return;
    if (await onShare(picked)) {
      setStaged([]);
      setQuery('');
    }
  };

  const showSuggestions = focused && suggestions.length > 0;
  const off = disabled || pending;

  return (
    <form
      className="flex gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <Popover open={showSuggestions} onOpenChange={(next) => !next && setFocused(false)}>
        <div className="relative min-w-0 flex-1">
          {/* The Input's own surface and focus ring, around chips and a bare text field. */}
          <PopoverAnchor asChild>
            <div
              ref={fieldRef}
              className={cn(
                inputSurfaceClasses,
                inputTransitionClasses,
                'focus-within:border-ring focus-within:ring-ring/15 flex min-h-10 cursor-text flex-wrap items-center gap-1 px-1 py-1 focus-within:ring-3',
                off && 'pointer-events-none opacity-50',
              )}
              onClick={() => document.getElementById(inputId)?.focus()}
            >
              {staged.map((candidate) => (
                <span
                  key={candidate.id}
                  className="bg-muted text-foreground flex h-7 max-w-full items-center gap-1.5 rounded-sm pr-0.5 pl-1 text-sm"
                >
                  <CandidateAvatar candidate={candidate} size="xs" />
                  <span className="min-w-0 truncate">{candidate.label}</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label={removeLabel}
                    className="text-muted-foreground hover:text-foreground size-6 shrink-0"
                    onClick={(event) => {
                      event.stopPropagation();
                      setStaged((current) => current.filter((other) => other.id !== candidate.id));
                    }}
                  >
                    <XIcon className="size-3" />
                  </Button>
                </span>
              ))}
              <input
                id={inputId}
                autoComplete="off"
                value={query}
                disabled={off}
                placeholder={staged.length ? '' : placeholder}
                aria-label={placeholder}
                role="combobox"
                aria-expanded={showSuggestions}
                aria-controls={`${inputId}-list`}
                className="text-foreground placeholder:text-muted-foreground h-8 min-w-32 flex-1 bg-transparent px-2 text-sm font-medium outline-none"
                onFocus={() => setFocused(true)}
                onBlur={() => setFocused(false)}
                onChange={(event) => setQuery(event.target.value)}
                onPaste={(event) => {
                  const text = event.clipboardData.getData('text');
                  if (!/[\s,;]/.test(text.trim())) return;
                  event.preventDefault();
                  const { found, unknown } = resolveEmails(text);
                  if (found.length) stage(found);
                  if (unknown.length) {
                    setQuery(unknown.join(', '));
                    onUnknownEmails(unknown);
                  }
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Backspace' && !query && staged.length) setStaged((current) => current.slice(0, -1));
                  if ((event.key === ',' || event.key === ' ') && query.includes('@')) {
                    event.preventDefault();
                    const { found, unknown } = resolveEmails(query);
                    if (found.length) stage(found);
                    if (unknown.length) onUnknownEmails(unknown);
                  }
                }}
              />
            </div>
          </PopoverAnchor>
          {/* Portalled above the dialog, so the list may run past its edge instead of being clipped by its scroll. */}
          <PopoverContent
            align="start"
            sideOffset={4}
            className="w-(--anchor-width) p-1"
            onOpenAutoFocus={(event) => event.preventDefault()}
            onCloseAutoFocus={(event) => event.preventDefault()}
            onInteractOutside={(event) => {
              if (fieldRef.current?.contains(event.target as Node)) event.preventDefault();
            }}
          >
            <ul id={`${inputId}-list`} role="listbox" className="max-h-72 overflow-y-auto overscroll-contain">
              {suggestions.map((candidate) => {
                const chosen = excludeIds.has(candidate.id) || stagedIds.has(candidate.id);
                return (
                  <li key={candidate.id} role="option" aria-selected={chosen}>
                    <button
                      type="button"
                      disabled={chosen}
                      // Keep focus in the field until the click lands.
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => stage([candidate])}
                      className={menuRow('lg', 'default', cn('gap-2.5 py-1.5 text-left', chosen ? 'cursor-default' : 'cursor-pointer'))}
                    >
                      <CandidateAvatar candidate={candidate} size="sm" />
                      <span className="min-w-0 flex-1">
                        <span className="text-foreground block truncate text-sm">{candidate.label}</span>
                        {candidate.sublabel ? (
                          <span className="text-muted-foreground block truncate text-xs font-normal">{candidate.sublabel}</span>
                        ) : null}
                      </span>
                      {chosen ? <CheckIcon aria-hidden className="text-muted-foreground size-4 shrink-0" /> : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          </PopoverContent>
        </div>
      </Popover>
      <Button type="submit" size="lg" className="shrink-0" disabled={off || (!needle && staged.length === 0)}>
        {pending ? <Loading className="size-4 shrink-0" /> : null}
        {shareLabel}
      </Button>
    </form>
  );
}
