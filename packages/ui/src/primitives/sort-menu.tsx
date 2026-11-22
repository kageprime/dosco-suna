'use client';

import { ArrowsDownUpIcon } from '@phosphor-icons/react';
import { useSyncExternalStore } from 'react';

import { Button } from './button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from './dropdown-menu';
import Hint from './hint';

export interface SortOption<T extends string> {
  value: T;
  label: string;
}

/**
 * A list page's sort: one outline icon button (the size of `ExpandableSearch`'s
 * closed button) that opens the orders as radio rows. The tooltip and the
 * accessible name say the order in use, e.g. "Sort: Last activity".
 */
export function SortMenu<T extends string>({
  value,
  onValueChange,
  options,
  label,
}: {
  value: T;
  onValueChange: (value: T) => void;
  options: SortOption<T>[];
  /** The button's name for the current order, e.g. "Sort: Name". */
  label: string;
}) {
  return (
    <DropdownMenu>
      <Hint label={label}>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="icon-base" aria-label={label} className="text-muted-foreground hover:text-foreground shrink-0">
            <ArrowsDownUpIcon className="size-4" />
          </Button>
        </DropdownMenuTrigger>
      </Hint>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuRadioGroup value={value} onValueChange={(next) => onValueChange(next as T)}>
          {options.map((option) => (
            <DropdownMenuRadioItem key={option.value} value={option.value} className="cursor-pointer">
              {option.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const SORT_EVENT = 'kortix:stored-sort';
// The orders picked this visit, for a browser that blocks storage.
const pickedThisVisit = new Map<string, string>();

function readStored(storageKey: string): string | null {
  try {
    return window.localStorage.getItem(storageKey) ?? pickedThisVisit.get(storageKey) ?? null;
  } catch {
    return pickedThisVisit.get(storageKey) ?? null;
  }
}

/**
 * The order a viewer picked last on one page, kept in this browser only
 * (`storageKey`). The server and the first render use `fallback`, so the HTML
 * matches; blocked storage, or an order the page no longer offers, also gives
 * `fallback`.
 */
export function useStoredSort<T extends string>(storageKey: string, orders: readonly T[], fallback: T): [T, (next: T) => void] {
  const stored = useSyncExternalStore(
    (onChange) => {
      window.addEventListener('storage', onChange);
      window.addEventListener(SORT_EVENT, onChange);
      return () => {
        window.removeEventListener('storage', onChange);
        window.removeEventListener(SORT_EVENT, onChange);
      };
    },
    () => readStored(storageKey),
    () => null,
  );
  const sort = orders.includes(stored as T) ? (stored as T) : fallback;
  const update = (next: T) => {
    pickedThisVisit.set(storageKey, next);
    try {
      window.localStorage.setItem(storageKey, next);
    } catch {
      // Blocked storage: the order lasts this visit (`pickedThisVisit`).
    }
    window.dispatchEvent(new Event(SORT_EVENT));
  };
  return [sort, update];
}
