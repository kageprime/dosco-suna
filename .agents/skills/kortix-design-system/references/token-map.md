# Token map: job → class → token

What you decide is the first column. What you write is the second. The third
is the CSS custom property the class reads, declared in
`apps/web/src/app/globals.css` (`:root` and `.dark`), generated from
`.agents/skills/kortix-brand/references/visual/visual-system.json`. This file
prints no value: the live values, light and dark, are measured on
`/design-system#tokens`, and the portable copy is
`.agents/skills/kortix-brand/references/visual/tokens.css`.

A match on value is wrong. Map by job: a border that happens to equal a text
grey is still `border-border`, never `text-muted-foreground`.

## Surface (depth, not taste)

| Job | Class | Token | JSON key |
| --- | --- | --- | --- |
| Page canvas | `bg-background` | `--background` | `color.semantic.background` |
| Content pane in the app shell | `bg-pane` | `--pane` | `color.semantic.pane` |
| Full-bleed pane standing in for the page (settings fullscreen only) | `bg-surface` | `--surface` | `color.semantic.surface` |
| Lifted region, sidebar, hover surface | `bg-card`, `bg-sidebar`, `bg-accent` | `--card`, `--sidebar`, `--accent` | `color.semantic.card` |
| Inset control, chip, track well, tile fill | `bg-secondary`, `bg-muted` | `--secondary`, `--muted` | `color.semantic.secondary` |
| Field, overlay, row or panel inside a panel | `bg-popover` | `--popover` | `color.semantic.popover` |
| Sidebar row fill, and a control on that row | `bg-sidebar-row`, `bg-sidebar-row-control` | `--sidebar-row`, `--sidebar-row-control` | `color.semantic.sidebar-row` |
| An in-flow bordered section directly on the page | `bg-background border-border` | `--background`, `--border` | (rule, color.md in-flow) |

## Ink and line

| Job | Class | Token |
| --- | --- | --- |
| Primary text | `text-foreground` | `--foreground` |
| Secondary text, meta, idle | `text-muted-foreground` | `--muted-foreground` |
| Text on a lifted or popover surface | `text-card-foreground`, `text-popover-foreground` | `--card-foreground`, `--popover-foreground` |
| Every border | `border-border` | `--border` |
| Sidebar border (softer in dark) | `border-sidebar-border` | `--sidebar-border` |
| Primary action fill and its text | `bg-primary text-primary-foreground` | `--primary`, `--primary-foreground` |

Never `text-foreground/60` or `text-muted-foreground/70`: hierarchy is surface
lift, not text opacity.

## Interaction

| Job | Class | Token |
| --- | --- | --- |
| Hover fill (transient) | `hover:bg-hover` | `--hover` |
| Selected fill (persistent) | `bg-active` | `--active` |
| Menu row highlight | `menuRow()` from `menu-recipe.ts` | `--primary` at 10% |
| Focus ring, link, brand | `focus-visible:ring-ring`, `text-ring` | `--ring` (`--kortix-base` aliases it) |
| Field focus | `inputFocusClasses` in `input.tsx`: `border-ring` + `ring-ring/15 ring-3` | `--ring` |
| Destructive action | `Button variant="destructive"` | `--destructive` |
| Disabled | `disabled:opacity-50 disabled:pointer-events-none` | (opacity, no token) |

## Status (one hue per meaning, D5)

| Job | Glyph or dot | Tint | Token |
| --- | --- | --- | --- |
| Brand, focus, links | `text-kortix-base` | `bg-kortix-base/15` | `--kortix-base` |
| Success, running, connected, merged | `text-kortix-green` | `bg-kortix-green/15` | `--kortix-green` |
| Error, failed | `text-kortix-red` | `bg-kortix-red/15` | `--kortix-red` |
| Warning, needs attention, a designed refusal | `text-kortix-orange` | `bg-kortix-orange/15` | `--kortix-orange` |
| Pending, awaiting you | `text-kortix-yellow` | `bg-kortix-yellow/15` | `--kortix-yellow` |
| Info, open, in review | `text-kortix-blue` | `bg-kortix-blue/15` | `--kortix-blue` |
| Owner role badge only | `Badge variant="royal"` | | `--kortix-purple` |
| Idle, off, unknown, a count | `text-muted-foreground`, `Badge size="tabular"` | none | |

The tint is `/15` and no other opacity. The label beside the mark stays ink.
`destructive` is for an action a person can take; `kortix-red` is for a state
that reports a failure.

## Geometry

| Job | Class | Token | Measured |
| --- | --- | --- | --- |
| Spacing base | every `p-*`, `gap-*`, `space-*` | `--spacing` = 0.23rem | `p-4` ≈ 14.7px, `gap-2` ≈ 7.4px |
| Allowed steps | `0 0.5 1 1.5 2 2.5 3 3.5 4 5 6 8 10 12 16 20 24` | `spacing.steps` | half steps only below 4 |
| Panel padding | `px-4 py-5` | | |
| Compact row | `px-4 py-3`; entity row `px-4 py-2` | | |
| Panel, row, table, card, button radius | `rounded-md` | `--radius-md` = `--radius` − 2px | 8px |
| Tile, chip, menu row, segmented chip | `rounded-sm` | `--radius-sm` = `--radius` − 4px | 6px |
| Floating panel (menu, popover, select) | `rounded-lg` | `--radius-lg` = `--radius` | 10px |
| Marketing surfaces only | `rounded-2xl` | `--radius-2xl` | 16px |
| Meta, captions, row descriptions | `text-xs` | `--text-xs` | 13px, the workhorse |
| Body, row titles, labels, buttons | `text-sm` | `--text-sm` | 14px |
| Long-form prose only | `text-base` | `--text-base` | 16px |
| Section page title | `text-xl font-medium` | `--text-xl` | 20px |
| Detail-view title, app ceiling | `text-2xl font-semibold tracking-tight` | `--text-2xl` | 24px |
| Marketing display and hero | `text-3xl` to `text-7xl` | | not in app chrome |
| Families | `font-sans`, `font-mono` | `--font-sans`, `--font-mono` | Roobert, Roobert Mono |
| Weights | `font-normal`, `font-medium`, `font-semibold` | | 400, 500, 600 |

`text-md` is non-canonical: add no use. No arbitrary size or spacing
(`text-[11px]`, `p-[16px]`); the one bracket exception is whole-pixel geometry
with a comment stating the arithmetic.

## Elevation

| Job | Class | Token |
| --- | --- | --- |
| In-flow panel, row, card | none: `border border-border` | |
| Raised segmented chip, slider thumb, glass panel | `shadow-xs` | `--shadow-xs` |
| Sticky bar | `shadow-sm` | `--shadow-sm` |
| Dropdown, select, popover, hover card | `shadow-md` + `border` | `--shadow-md` |
| Modal, sheet, toast | `shadow-lg` + `border` | `--shadow-lg` |
| Command palette, floating window | `shadow-xl` | `--shadow-xl` |

Never `dark:shadow-*`, never `shadow-[…]` when a step fits.

## Motion

| Job | Class | Token | Value |
| --- | --- | --- | --- |
| Hover color, opacity | `transition-colors duration-fast` | `--duration-fast` | 100ms |
| The default UI transition | `duration-normal` | `--duration-normal` | 150ms |
| Disclosure, accordion, tab | `duration-moderate` | `--duration-moderate` | 200ms |
| Modal, drawer, sheet; the product ceiling | `duration-slow` | `--duration-slow` | 300ms |
| Marketing and decks only | `duration-slower` | `--duration-slower` | 500ms |
| Enter and exit | `ease-out` | | |
| On-screen move or morph | `ease-in-out` | | |
| Press | `active:scale-[0.96]`; full-width row `0.998` | `effects.press` | |
| Menus, selects, popovers, tooltips, the palette | none: `MENU_PANEL_STATIC`, `FLOATING_PANEL_SURFACE` | | 0ms |
| Hover card | `FLOATING_PANEL` | | the one animated floating panel |

The durations above are read from `motion.*` in `visual-system.json` at the
time of writing (2026-11-07). The page measures them live; if the two disagree,
the page is right and this file is stale.

## Escape hatches

Only three reasons to write a value outside the tokens: a third-party brand
color in a named constant beside the component, raw color inside an art module,
and a user-chosen glyph or emoji palette. There is no fourth. `audit.sh` reads
the source text; a `cn()` wrapper does not launder a raw value.
