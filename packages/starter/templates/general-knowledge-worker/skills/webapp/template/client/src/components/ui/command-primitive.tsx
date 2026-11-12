"use client"

/**
 * The headless command list behind `./command`: a port of cmdk 0.2.1 without
 * its Radix dialog. It keeps cmdk's API (`Command`, `Command.Input`,
 * `Command.List`, ...), so cmdk examples work unchanged.
 *
 * cmdk depends on `@radix-ui/react-dialog` for `Command.Dialog`; this port
 * drops it, and `CommandDialog` in `./command` wraps the template's Base UI
 * `Dialog` instead.
 *
 * cmdk: Copyright (c) 2022 Paco Coursey. MIT License. Permission is hereby
 * granted, free of charge, to any person obtaining a copy of this software and
 * associated documentation files (the "Software"), to deal in the Software
 * without restriction, including without limitation the rights to use, copy,
 * modify, merge, publish, distribute, sublicense, and/or sell copies of the
 * Software, and to permit persons to whom the Software is furnished to do so,
 * subject to the following conditions: The above copyright notice and this
 * permission notice shall be included in all copies or substantial portions
 * of the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY
 * KIND, EXPRESS OR IMPLIED.
 */

import * as React from "react"

/* ---------- command-score (cmdk 0.2.1) ---------- */

const SCORE_CONTINUE_MATCH = 1
const SCORE_SPACE_WORD_JUMP = 0.9
const SCORE_NON_SPACE_WORD_JUMP = 0.8
const SCORE_CHARACTER_JUMP = 0.17
const SCORE_TRANSPOSITION = 0.1
const PENALTY_SKIPPED = 0.999
const PENALTY_CASE_MISMATCH = 0.9999
const PENALTY_NOT_COMPLETE = 0.99
const IS_GAP_REGEXP = /[\\/_+.#"@[({&]/
const COUNT_GAPS_REGEXP = /[\\/_+.#"@[({&]/g
const IS_SPACE_REGEXP = /[\s-]/
const COUNT_SPACE_REGEXP = /[\s-]/g

function scoreFrom(
  string: string,
  abbreviation: string,
  lowerString: string,
  lowerAbbreviation: string,
  stringIndex: number,
  abbreviationIndex: number,
  memo: Record<string, number>,
): number {
  if (abbreviationIndex === abbreviation.length) {
    return stringIndex === string.length
      ? SCORE_CONTINUE_MATCH
      : PENALTY_NOT_COMPLETE
  }
  const memoKey = `${stringIndex},${abbreviationIndex}`
  if (memo[memoKey] !== undefined) return memo[memoKey]

  const abbreviationChar = lowerAbbreviation.charAt(abbreviationIndex)
  let index = lowerString.indexOf(abbreviationChar, stringIndex)
  let highScore = 0

  while (index >= 0) {
    let score = scoreFrom(
      string,
      abbreviation,
      lowerString,
      lowerAbbreviation,
      index + 1,
      abbreviationIndex + 1,
      memo,
    )
    if (score > highScore) {
      if (index === stringIndex) {
        score *= SCORE_CONTINUE_MATCH
      } else if (IS_GAP_REGEXP.test(string.charAt(index - 1))) {
        score *= SCORE_NON_SPACE_WORD_JUMP
        const gaps = string
          .slice(stringIndex, index - 1)
          .match(COUNT_GAPS_REGEXP)
        if (gaps && stringIndex > 0)
          score *= Math.pow(PENALTY_SKIPPED, gaps.length)
      } else if (IS_SPACE_REGEXP.test(string.charAt(index - 1))) {
        score *= SCORE_SPACE_WORD_JUMP
        const spaces = string
          .slice(stringIndex, index - 1)
          .match(COUNT_SPACE_REGEXP)
        if (spaces && stringIndex > 0)
          score *= Math.pow(PENALTY_SKIPPED, spaces.length)
      } else {
        score *= SCORE_CHARACTER_JUMP
        if (stringIndex > 0)
          score *= Math.pow(PENALTY_SKIPPED, index - stringIndex)
      }
      if (string.charAt(index) !== abbreviation.charAt(abbreviationIndex)) {
        score *= PENALTY_CASE_MISMATCH
      }
    }
    if (
      (score < SCORE_TRANSPOSITION &&
        lowerString.charAt(index - 1) ===
          lowerAbbreviation.charAt(abbreviationIndex + 1)) ||
      (lowerAbbreviation.charAt(abbreviationIndex + 1) ===
        lowerAbbreviation.charAt(abbreviationIndex) &&
        lowerString.charAt(index - 1) !==
          lowerAbbreviation.charAt(abbreviationIndex))
    ) {
      const transposedScore = scoreFrom(
        string,
        abbreviation,
        lowerString,
        lowerAbbreviation,
        index + 1,
        abbreviationIndex + 2,
        memo,
      )
      if (transposedScore * SCORE_TRANSPOSITION > score) {
        score = transposedScore * SCORE_TRANSPOSITION
      }
    }
    if (score > highScore) highScore = score
    index = lowerString.indexOf(abbreviationChar, index + 1)
  }

  memo[memoKey] = highScore
  return highScore
}

function formatInput(value: string) {
  return value.toLowerCase().replace(COUNT_SPACE_REGEXP, " ")
}

/** cmdk's default filter: 0 hides the row, 1 is a perfect match. */
export function commandScore(string: string, abbreviation: string): number {
  return scoreFrom(
    string,
    abbreviation,
    formatInput(string),
    formatInput(abbreviation),
    0,
    0,
    {},
  )
}

/* ---------- store and contexts ---------- */

const LIST_SIZER_SELECTOR = '[cmdk-list-sizer=""]'
const GROUP_SELECTOR = '[cmdk-group=""]'
const GROUP_ITEMS_SELECTOR = '[cmdk-group-items=""]'
const GROUP_HEADING_SELECTOR = '[cmdk-group-heading=""]'
const ITEM_SELECTOR = '[cmdk-item=""]'
const VALID_ITEM_SELECTOR = `${ITEM_SELECTOR}:not([aria-disabled="true"])`
const SELECT_EVENT = "cmdk-item-select"
const VALUE_ATTR = "data-value"

export interface CommandState {
  search: string
  value: string
  filtered: { count: number; items: Map<string, number>; groups: Set<string> }
}

interface Store {
  subscribe: (callback: () => void) => () => void
  snapshot: () => CommandState
  setState: <K extends keyof CommandState>(
    key: K,
    value: CommandState[K],
    opts?: boolean,
  ) => void
  emit: () => void
}

interface Context {
  value: (id: string, value: string | undefined) => void
  item: (id: string, groupId: string | undefined) => () => void
  group: (id: string) => () => void
  filter: () => boolean | undefined
  label: string | undefined
  commandRef: React.RefObject<HTMLDivElement | null>
  listId: string
  labelId: string
  inputId: string
}

interface GroupContextValue {
  id: string
  forceMount?: boolean
}

const CommandContext = React.createContext<Context | undefined>(undefined)
const StoreContext = React.createContext<Store | undefined>(undefined)
const GroupContext = React.createContext<GroupContextValue | undefined>(
  undefined,
)

const useCommand = () => React.useContext(CommandContext)!
const useStore = () => React.useContext(StoreContext)!

const useIsomorphicLayoutEffect =
  typeof window === "undefined" ? React.useEffect : React.useLayoutEffect

function useLazyRef<T>(init: () => T) {
  const ref = React.useRef<T | undefined>(undefined)
  if (ref.current === undefined) ref.current = init()
  return ref as React.MutableRefObject<T>
}

function useLatest<T>(value: T) {
  const ref = React.useRef(value)
  useIsomorphicLayoutEffect(() => {
    ref.current = value
  })
  return ref
}

function mergeRefs<T>(
  refs: Array<React.Ref<T> | undefined>,
): React.RefCallback<T> {
  return (node) => {
    for (const ref of refs) {
      if (typeof ref === "function") ref(node)
      else if (ref) (ref as React.MutableRefObject<T | null>).current = node
    }
  }
}

/** Reads a slice of the command state; re-renders when it changes. */
export function useCommandState<T>(selector: (state: CommandState) => T): T {
  const store = useStore()
  const get = () => selector(store.snapshot())
  return React.useSyncExternalStore(store.subscribe, get, get)
}

/** Batches store work into one layout effect after the next render. */
function useScheduleLayoutEffect() {
  const [tick, setTick] = React.useState<object>()
  const fns = useLazyRef(() => new Map<string | number, () => void>())
  useIsomorphicLayoutEffect(() => {
    fns.current.forEach((fn) => fn())
    fns.current = new Map()
  }, [tick])
  return (id: string | number, cb: () => void) => {
    fns.current.set(id, cb)
    setTick({})
  }
}

/**
 * A row's or group's identity: the first string in `deps`, else the text of
 * the first ref's element, trimmed and lowercased — as cmdk computes it.
 */
function useValue(
  id: string,
  ref: React.RefObject<HTMLElement | null>,
  deps: Array<unknown>,
): React.MutableRefObject<string | undefined> {
  const valueRef = React.useRef<string | undefined>(undefined)
  const context = useCommand()
  useIsomorphicLayoutEffect(() => {
    const value = (() => {
      for (const part of deps) {
        if (typeof part === "string") return part.trim().toLowerCase()
        if (typeof part === "object" && part && "current" in part) {
          const node = (part as React.RefObject<HTMLElement | null>).current
          return node
            ? node.textContent?.trim().toLowerCase()
            : valueRef.current
        }
      }
      return undefined
    })()
    context.value(id, value)
    ref.current?.setAttribute(VALUE_ATTR, value as string)
    valueRef.current = value
  })
  return valueRef
}

const SR_ONLY: React.CSSProperties = {
  position: "absolute",
  width: "1px",
  height: "1px",
  padding: "0",
  margin: "-1px",
  overflow: "hidden",
  clip: "rect(0, 0, 0, 0)",
  whiteSpace: "nowrap",
  borderWidth: "0",
}

/* ---------- root ---------- */

type DivProps = React.HTMLAttributes<HTMLDivElement>

export type CommandRootProps = DivProps & {
  /** Accessible label for this command menu. Not shown visibly. */
  label?: string
  /** `false` turns off filtering; the caller renders only matching rows. */
  shouldFilter?: boolean
  /** Returns 0 (hide) to 1 (best match). Defaults to `commandScore`. */
  filter?: (value: string, search: string) => number
  /** The highlighted row's value on first render. */
  defaultValue?: string
  /** The highlighted row's value, controlled. */
  value?: string
  onValueChange?: (value: string) => void
  /** Arrow keys wrap from the last row to the first and back. */
  loop?: boolean
  /** `false` turns off ctrl+n/j/p/k. Defaults to `true`. */
  vimBindings?: boolean
}

export const CommandRoot = React.forwardRef<HTMLDivElement, CommandRootProps>(
  (props, forwardedRef) => {
    const ref = React.useRef<HTMLDivElement | null>(null)
    const state = useLazyRef<CommandState>(() => ({
      search: "",
      value: props.value ?? props.defaultValue?.toLowerCase() ?? "",
      filtered: { count: 0, items: new Map(), groups: new Set() },
    }))
    const allItems = useLazyRef(() => new Set<string>())
    const allGroups = useLazyRef(() => new Map<string, Set<string>>())
    const ids = useLazyRef(() => new Map<string, string | undefined>())
    const listeners = useLazyRef(() => new Set<() => void>())
    const propsRef = useLatest(props)
    const {
      label,
      children,
      value,
      onValueChange: _onValueChange,
      filter: _filter,
      shouldFilter: _shouldFilter,
      vimBindings = true,
      loop: _loop,
      defaultValue: _defaultValue,
      ...etc
    } = props

    const listId = React.useId()
    const labelId = React.useId()
    const inputId = React.useId()
    const schedule = useScheduleLayoutEffect()

    useIsomorphicLayoutEffect(() => {
      if (value !== undefined) {
        state.current.value = value.trim().toLowerCase()
        schedule(6, scrollSelectedIntoView)
        store.emit()
      }
    }, [value])

    const store: Store = React.useMemo(
      () => ({
        subscribe: (cb) => {
          listeners.current.add(cb)
          return () => listeners.current.delete(cb)
        },
        snapshot: () => state.current,
        setState: (key, next, opts) => {
          if (Object.is(state.current[key], next)) return
          state.current[key] = next
          if (key === "search") {
            filterItems()
            sort()
            schedule(1, selectFirstItem)
          } else if (key === "value") {
            if (propsRef.current.value !== undefined) {
              propsRef.current.onValueChange?.(
                (next as string | undefined) ?? "",
              )
              return
            } else if (!opts) {
              schedule(5, scrollSelectedIntoView)
            }
          }
          store.emit()
        },
        emit: () => listeners.current.forEach((l) => l()),
      }),
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [],
    )

    const context: Context = React.useMemo(
      () => ({
        value: (id, next) => {
          if (next !== ids.current.get(id)) {
            ids.current.set(id, next)
            state.current.filtered.items.set(id, score(next))
            schedule(2, () => {
              sort()
              store.emit()
            })
          }
        },
        item: (id, groupId) => {
          allItems.current.add(id)
          if (groupId) {
            const group = allGroups.current.get(groupId)
            if (group) group.add(id)
            else allGroups.current.set(groupId, new Set([id]))
          }
          schedule(3, () => {
            filterItems()
            sort()
            if (!state.current.value) selectFirstItem()
            store.emit()
          })
          return () => {
            ids.current.delete(id)
            allItems.current.delete(id)
            state.current.filtered.items.delete(id)
            const selected = getSelectedItem()
            schedule(4, () => {
              filterItems()
              if (selected?.getAttribute("id") === id) selectFirstItem()
              store.emit()
            })
          }
        },
        group: (id) => {
          if (!allGroups.current.has(id)) allGroups.current.set(id, new Set())
          return () => {
            ids.current.delete(id)
            allGroups.current.delete(id)
          }
        },
        filter: () => propsRef.current.shouldFilter,
        label: label || (props["aria-label"] as string | undefined),
        commandRef: ref,
        listId,
        inputId,
        labelId,
      }),
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [],
    )

    function score(next: string | undefined) {
      const filter = propsRef.current.filter ?? commandScore
      return next ? filter(next, state.current.search) : 0
    }

    /** cmdk 0.2.1's re-sort, as shipped (see the file comment). */
    function sort() {
      if (
        !ref.current ||
        !state.current.search ||
        propsRef.current.shouldFilter === false
      )
        return
      const scores = state.current.filtered.items
      const groups: Array<[string, number]> = []
      state.current.filtered.groups.forEach((groupId) => {
        let max = 0
        allGroups.current.get(groupId)?.forEach((itemId) => {
          max = Math.max(scores.get(itemId) ?? 0, max)
        })
        groups.push([groupId, max])
      })
      const sizer = ref.current.querySelector(LIST_SIZER_SELECTOR)
      getValidItems()
        .sort(
          (a, b) =>
            (scores.get(b.getAttribute(VALUE_ATTR) as string) ?? 0) -
            (scores.get(a.getAttribute(VALUE_ATTR) as string) ?? 0),
        )
        .forEach((item) => {
          const group = item.closest(GROUP_ITEMS_SELECTOR)
          const parent = group ?? sizer
          const node =
            item.parentElement === parent
              ? item
              : item.closest(`${GROUP_ITEMS_SELECTOR} > *`)
          if (parent && node) parent.appendChild(node)
        })
      groups
        .sort((a, b) => b[1] - a[1])
        .forEach(([groupId]) => {
          const element = ref.current?.querySelector(
            `${GROUP_SELECTOR}[${VALUE_ATTR}="${groupId}"]`,
          )
          element?.parentElement?.appendChild(element)
        })
    }

    function selectFirstItem() {
      const item = getValidItems().find(
        (el) => el.getAttribute("aria-disabled") !== "true",
      )
      const next = item?.getAttribute(VALUE_ATTR)
      store.setState("value", (next || undefined) as string)
    }

    function filterItems() {
      if (!state.current.search || propsRef.current.shouldFilter === false) {
        state.current.filtered.count = allItems.current.size
        return
      }
      state.current.filtered.groups = new Set()
      let count = 0
      for (const id of Array.from(allItems.current)) {
        const rank = score(ids.current.get(id))
        state.current.filtered.items.set(id, rank)
        if (rank > 0) count++
      }
      for (const [groupId, group] of Array.from(allGroups.current)) {
        for (const itemId of Array.from(group)) {
          if ((state.current.filtered.items.get(itemId) ?? 0) > 0) {
            state.current.filtered.groups.add(groupId)
            break
          }
        }
      }
      state.current.filtered.count = count
    }

    function scrollSelectedIntoView() {
      const item = getSelectedItem()
      if (!item) return
      if (item.parentElement?.firstChild === item) {
        item
          .closest(GROUP_SELECTOR)
          ?.querySelector(GROUP_HEADING_SELECTOR)
          ?.scrollIntoView({ block: "nearest" })
      }
      item.scrollIntoView({ block: "nearest" })
    }

    function getSelectedItem() {
      return (
        ref.current?.querySelector<HTMLElement>(
          `${ITEM_SELECTOR}[aria-selected="true"]`,
        ) ?? null
      )
    }

    function getValidItems() {
      return Array.from(
        ref.current?.querySelectorAll<HTMLElement>(VALID_ITEM_SELECTOR) ?? [],
      )
    }

    function updateSelectedToIndex(index: number) {
      const item = getValidItems()[index]
      if (item) store.setState("value", item.getAttribute(VALUE_ATTR) as string)
    }

    function updateSelectedByChange(change: 1 | -1) {
      const selected = getSelectedItem()
      const items = getValidItems()
      const index = items.findIndex((item) => item === selected)
      let next = items[index + change]
      if (propsRef.current.loop) {
        next =
          index + change < 0
            ? items[items.length - 1]
            : index + change === items.length
              ? items[0]
              : items[index + change]
      }
      if (next) store.setState("value", next.getAttribute(VALUE_ATTR) as string)
    }

    function updateSelectedToGroup(change: 1 | -1) {
      let group = getSelectedItem()?.closest(GROUP_SELECTOR) ?? null
      let item: HTMLElement | null | undefined = null
      while (group && !item) {
        group =
          change > 0
            ? findNextSibling(group, GROUP_SELECTOR)
            : findPreviousSibling(group, GROUP_SELECTOR)
        item = group?.querySelector<HTMLElement>(VALID_ITEM_SELECTOR)
      }
      if (item) store.setState("value", item.getAttribute(VALUE_ATTR) as string)
      else updateSelectedByChange(change)
    }

    const last = () => updateSelectedToIndex(getValidItems().length - 1)
    const next = (e: React.KeyboardEvent) => {
      e.preventDefault()
      if (e.metaKey) last()
      else if (e.altKey) updateSelectedToGroup(1)
      else updateSelectedByChange(1)
    }
    const prev = (e: React.KeyboardEvent) => {
      e.preventDefault()
      if (e.metaKey) updateSelectedToIndex(0)
      else if (e.altKey) updateSelectedToGroup(-1)
      else updateSelectedByChange(-1)
    }

    return (
      <div
        ref={mergeRefs([ref, forwardedRef])}
        {...etc}
        cmdk-root=""
        onKeyDown={(e) => {
          etc.onKeyDown?.(e)
          if (e.defaultPrevented) return
          switch (e.key) {
            case "n":
            case "j":
              if (vimBindings && e.ctrlKey) next(e)
              break
            case "ArrowDown":
              next(e)
              break
            case "p":
            case "k":
              if (vimBindings && e.ctrlKey) prev(e)
              break
            case "ArrowUp":
              prev(e)
              break
            case "Home":
              e.preventDefault()
              updateSelectedToIndex(0)
              break
            case "End":
              e.preventDefault()
              last()
              break
            case "Enter":
              if (!e.nativeEvent.isComposing) {
                e.preventDefault()
                getSelectedItem()?.dispatchEvent(new Event(SELECT_EVENT))
              }
          }
        }}
      >
        <label
          cmdk-label=""
          htmlFor={context.inputId}
          id={context.labelId}
          style={SR_ONLY}
        >
          {label}
        </label>
        <StoreContext.Provider value={store}>
          <CommandContext.Provider value={context}>
            {children}
          </CommandContext.Provider>
        </StoreContext.Provider>
      </div>
    )
  },
)
CommandRoot.displayName = "CommandRoot"

function findNextSibling(el: Element, selector: string) {
  let sibling = el.nextElementSibling
  while (sibling) {
    if (sibling.matches(selector)) return sibling
    sibling = sibling.nextElementSibling
  }
  return null
}

function findPreviousSibling(el: Element, selector: string) {
  let sibling = el.previousElementSibling
  while (sibling) {
    if (sibling.matches(selector)) return sibling
    sibling = sibling.previousElementSibling
  }
  return null
}

/* ---------- item ---------- */

export type CommandItemProps = Omit<
  DivProps,
  "disabled" | "onSelect" | "value"
> & {
  disabled?: boolean
  /** Called on click and on Enter while highlighted. */
  onSelect?: (value: string) => void
  /** The row's identity; defaults to its text. */
  value?: string
  /** Render regardless of filtering. */
  forceMount?: boolean
}

export const CommandItemCore = React.forwardRef<
  HTMLDivElement,
  CommandItemProps
>((props, forwardedRef) => {
  const id = React.useId()
  const ref = React.useRef<HTMLDivElement | null>(null)
  const groupContext = React.useContext(GroupContext)
  const context = useCommand()
  const propsRef = useLatest(props)
  const forceMount = propsRef.current?.forceMount ?? groupContext?.forceMount

  useIsomorphicLayoutEffect(() => context.item(id, groupContext?.id), [])

  const value = useValue(id, ref, [props.value, props.children, ref])
  const store = useStore()
  const selected = useCommandState(
    (s) => Boolean(s.value) && s.value === value.current,
  )
  const render = useCommandState((s) =>
    forceMount || context.filter() === false
      ? true
      : s.search
        ? (s.filtered.items.get(id) ?? 0) > 0
        : true,
  )

  React.useEffect(() => {
    const element = ref.current
    if (!element || props.disabled) return
    element.addEventListener(SELECT_EVENT, onSelect)
    return () => element.removeEventListener(SELECT_EVENT, onSelect)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [render, props.onSelect, props.disabled])

  function onSelect() {
    select()
    propsRef.current.onSelect?.(value.current as string)
  }

  function select() {
    store.setState("value", value.current as string, true)
  }

  if (!render) return null

  const {
    disabled,
    value: _value,
    onSelect: _onSelect,
    forceMount: _forceMount,
    ...etc
  } = props

  return (
    <div
      ref={mergeRefs([ref, forwardedRef])}
      {...etc}
      id={id}
      cmdk-item=""
      role="option"
      aria-disabled={disabled || undefined}
      aria-selected={selected || undefined}
      data-disabled={disabled || undefined}
      data-selected={selected || undefined}
      onPointerMove={disabled ? undefined : select}
      onClick={disabled ? undefined : onSelect}
    >
      {props.children}
    </div>
  )
})
CommandItemCore.displayName = "CommandItemCore"

/* ---------- group ---------- */

export type CommandGroupProps = Omit<DivProps, "value" | "heading"> & {
  heading?: React.ReactNode
  /** Required when there is no heading: the group's unique value. */
  value?: string
  /** Render regardless of filtering, with every row in it. */
  forceMount?: boolean
}

export const CommandGroupCore = React.forwardRef<
  HTMLDivElement,
  CommandGroupProps
>((props, forwardedRef) => {
  const { heading, children, forceMount, ...etc } = props
  const id = React.useId()
  const ref = React.useRef<HTMLDivElement | null>(null)
  const headingRef = React.useRef<HTMLDivElement | null>(null)
  const headingId = React.useId()
  const context = useCommand()
  const render = useCommandState((s) =>
    forceMount || context.filter() === false
      ? true
      : s.search
        ? s.filtered.groups.has(id)
        : true,
  )

  useIsomorphicLayoutEffect(() => context.group(id), [])
  useValue(id, ref, [props.value, props.heading, headingRef])

  const contextValue = React.useMemo(
    () => ({ id, forceMount }),
    [id, forceMount],
  )

  return (
    <div
      ref={mergeRefs([ref, forwardedRef])}
      {...etc}
      cmdk-group=""
      role="presentation"
      hidden={render ? undefined : true}
    >
      {heading && (
        <div ref={headingRef} cmdk-group-heading="" aria-hidden id={headingId}>
          {heading}
        </div>
      )}
      <div
        cmdk-group-items=""
        role="group"
        aria-labelledby={heading ? headingId : undefined}
      >
        <GroupContext.Provider value={contextValue}>
          {children}
        </GroupContext.Provider>
      </div>
    </div>
  )
})
CommandGroupCore.displayName = "CommandGroupCore"

/* ---------- separator, input, list, empty ---------- */

export const CommandSeparatorCore = React.forwardRef<
  HTMLDivElement,
  DivProps & { alwaysRender?: boolean }
>(({ alwaysRender, ...etc }, forwardedRef) => {
  const render = useCommandState((s) => !s.search)
  if (!alwaysRender && !render) return null
  return <div ref={forwardedRef} {...etc} cmdk-separator="" role="separator" />
})
CommandSeparatorCore.displayName = "CommandSeparatorCore"

export type CommandInputProps = Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  "value" | "onChange" | "type"
> & {
  value?: string
  onValueChange?: (search: string) => void
}

export const CommandInputCore = React.forwardRef<
  HTMLInputElement,
  CommandInputProps
>(({ onValueChange, ...etc }, forwardedRef) => {
  const isControlled = etc.value != null
  const store = useStore()
  const search = useCommandState((s) => s.search)
  const value = useCommandState((s) => s.value)
  const context = useCommand()

  const selectedItemId = React.useMemo(() => {
    const item = context.commandRef.current?.querySelector(
      `${ITEM_SELECTOR}[${VALUE_ATTR}="${value}"]`,
    )
    return item?.getAttribute("id") ?? undefined
  }, [value, context.commandRef])

  React.useEffect(() => {
    if (etc.value != null) store.setState("search", etc.value)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [etc.value])

  return (
    <input
      ref={forwardedRef}
      {...etc}
      cmdk-input=""
      autoComplete="off"
      autoCorrect="off"
      spellCheck={false}
      aria-autocomplete="list"
      role="combobox"
      aria-expanded
      aria-controls={context.listId}
      aria-labelledby={context.labelId}
      aria-activedescendant={selectedItemId}
      id={context.inputId}
      type="text"
      value={isControlled ? etc.value : search}
      onChange={(e) => {
        if (!isControlled) store.setState("search", e.target.value)
        onValueChange?.(e.target.value)
      }}
    />
  )
})
CommandInputCore.displayName = "CommandInputCore"

export const CommandListCore = React.forwardRef<HTMLDivElement, DivProps>(
  ({ children, ...etc }, forwardedRef) => {
    const ref = React.useRef<HTMLDivElement | null>(null)
    const height = React.useRef<HTMLDivElement | null>(null)
    const context = useCommand()

    React.useEffect(() => {
      if (
        !height.current ||
        !ref.current ||
        typeof ResizeObserver === "undefined"
      )
        return
      const sizer = height.current
      const list = ref.current
      let frame: number
      const observer = new ResizeObserver(() => {
        frame = requestAnimationFrame(() => {
          list.style.setProperty(
            "--cmdk-list-height",
            `${sizer.offsetHeight.toFixed(1)}px`,
          )
        })
      })
      observer.observe(sizer)
      return () => {
        cancelAnimationFrame(frame)
        observer.unobserve(sizer)
      }
    }, [])

    return (
      <div
        ref={mergeRefs([ref, forwardedRef])}
        {...etc}
        cmdk-list=""
        role="listbox"
        aria-label="Suggestions"
        id={context.listId}
        aria-labelledby={context.inputId}
      >
        <div ref={height} cmdk-list-sizer="">
          {children}
        </div>
      </div>
    )
  },
)
CommandListCore.displayName = "CommandListCore"

/** Shows when no row matches the search. Hidden on the first render, as in cmdk. */
export const CommandEmptyCore = React.forwardRef<HTMLDivElement, DivProps>(
  (props, forwardedRef) => {
    const isFirstRender = React.useRef(true)
    const render = useCommandState((s) => s.filtered.count === 0)
    React.useEffect(() => {
      isFirstRender.current = false
    }, [])
    // eslint-disable-next-line react-hooks/refs
    if (isFirstRender.current || !render) return null
    return (
      <div ref={forwardedRef} {...props} cmdk-empty="" role="presentation" />
    )
  },
)
CommandEmptyCore.displayName = "CommandEmptyCore"

/** cmdk's compound API: `<Command>`, `<Command.Input>`, `<Command.List>`, ... */
export const Command = Object.assign(CommandRoot, {
  Input: CommandInputCore,
  List: CommandListCore,
  Empty: CommandEmptyCore,
  Group: CommandGroupCore,
  Item: CommandItemCore,
  Separator: CommandSeparatorCore,
})
