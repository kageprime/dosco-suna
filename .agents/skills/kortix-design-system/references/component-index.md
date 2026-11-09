# Component index

Every primitive in `packages/ui/src/primitives/`, imported by apps/web as
`@kortix/ui/<name>`. The anchor is where `/design-system` renders it. A row
with no anchor is not on the page yet: add it there when you touch it (the
"self-documenting" rule in `SKILL.md`). Status: **use** (the current component
for its job), **internal** (a part other primitives compose), **legacy** (serves
old call sites, add no use; the replacement is named), **art** (an art module,
raw color allowed).

## Actions and controls

| Primitive | Job | Anchor | Status |
| --- | --- | --- | --- |
| `button` | every clickable control; variants and sizes in `SKILL.md` "Button conventions" | `#comp-button` | use |
| `button-group` | two or more buttons that serve one surface, one variant, `gap-px` | `#comp-button-group` | use |
| `toggle` | a two-state button | `#comp-toggle` | use |
| `switch` | an on/off setting | `#comp-switch` | use |
| `checkbox`, `checkbox-group` | multi-select | `#comp-checkbox` | use |
| `radio-group` | single-select, few options | `#comp-radio` | use |
| `slider`, `slider-native` | a range | `#comp-slider` | use |
| `kbd` | a keyboard shortcut | `#comp-kbd` | use |
| `count-badge` | a count beside a label, tone by meaning | | use |
| `back-pill` | the back control of a nested view | | use |
| `confirm-dialog`, `type-to-confirm-dialog` | mandatory before any destructive mutation | `#comp-alert-dialog` (pattern) | use |

## Fields and forms

| Primitive | Job | Anchor | Status |
| --- | --- | --- | --- |
| `input`, `textarea` | the one field surface: `bg-popover border rounded-md` | `#comp-input`, `#comp-textarea` | use |
| `input-group` | a search field (`InputGroupSearch`) or a field with addons; the required search field | | use |
| `field` | `Field`, `FieldLabel`, `FieldGroup`, `FieldDescription` in panels and modals | | use |
| `label` | a panel or group heading at `text-sm font-medium` | `#comp-label` | use |
| `select` | a single pick from a list, instant open | `#comp-select` | use |
| `calendar`, `date-range-picker` | a date or a range | `#comp-calendar` | use |
| `phone-input` | a phone number with a country | | use |
| `emoji-picker`, `project-icon-picker`, `glyph-picker`, `glyph-face`, `glyph-registry` | an icon or emoji for a project; the glyph set and its tints | `#comp-emoji-picker`, `#comp-project-icon-picker` | use |
| `page-search-bar` | compact page-header search beside the primary action | `#pat-search-bar` | use |

## Surfaces and layout

| Primitive | Job | Anchor | Status |
| --- | --- | --- | --- |
| `card` | the codified panel: header, content, footer, flush children | `#comp-card` | use |
| `section` | a labelled section inside a page shell (marketing-profile eyebrow) | `#pat-section` | use |
| `separator` | a hairline between groups | `#comp-separator` | use |
| `scroll-area`, `faded-scroll-area` | a scroller; the faded one for a nav rail | `#comp-scrollarea` | use |
| `resizable`, `resize-seam` | split panes | | use |
| `split-sheet` | a sheet split into art and content | | use |
| `tabs`, `sliding-tab-indicator` | segmented (default), `type="underline"`, `size="xs"` for filters; `variant="secondary"` for a secondary active fill | `#comp-tabs` | use |
| `disclosure`, `collapsible`, `accordion` | expand and collapse; `Disclosure` for config lists | `#comp-collapsible`, `#comp-accordion` | use |
| `table`, `data-grid` | tabular data; the grid for large sets | `#comp-table` | use |
| `definition-list` | key and value pairs | `#pat-definition-list` | use |
| `inline-meta` | metadata with visible separators, optional count previews, and exact timestamp hover cards | `#pat-inline-meta` | use |
| `item` | an entity row body | | internal |
| `sidebar`, `sidebar-panel`, `sidebar-context`, `sidebar-menu-primitives`, `sidebar-width`, `sidebar-peek` | the app sidebar | | use |
| `settings-row`, `settings-section-header`, `settings-subsection-header` | settings screens | | use |
| `stepper` | a numbered flow | | use |
| `section-card` | a second panel system beside `Card` | `#pat-banned` | legacy: `Card` or `bg-popover rounded-md border px-4 py-5` |
| `list` | `List` / `ListRow`, a divider-separated list | `#pat-banned` | legacy: `<ul className="space-y-2">` + entity row classes |

## Overlays

| Primitive | Job | Anchor | Status |
| --- | --- | --- | --- |
| `modal` | every dialog and sheet in feature code | `#comp-modal` | use |
| `dialog`, `alert-dialog`, `sheet`, `drawer` | the parts `Modal` and `ConfirmDialog` compose | `#comp-dialog`, `#comp-alert-dialog`, `#comp-sheet` | use |
| `popover` | a small anchored panel, instant open | `#comp-popover` | use |
| `hover-card` | the one animated floating panel; the info icon's card | `#interaction-translate` | use |
| `hint` | the tooltip of an icon-only control | `#comp-tooltip` | use |
| `tooltip` | the part `Hint` composes | `#comp-tooltip` | use |
| `dropdown-menu`, `context-menu`, `navigation-menu`, `command` | menus; one row grid from `menu-recipe.ts`, instant open | `#comp-dropdown` | use |
| `portal` | portal container plumbing | | internal |

## Status and feedback

| Primitive | Job | Anchor | Status |
| --- | --- | --- | --- |
| `badge` | a status chip; variants carry the hue | `#comp-badge` | use |
| `status` | `StatusDot`, `StatusBadge`, `DiffStat`, the `STATUS_*` maps | `#pat-status` | use |
| `status-ring` | the shared status circle geometry | | internal |
| `tag` | a removable tag | | use |
| `alert` | inline status and warning messages | `#comp-alert` | use |
| `toast` | `successToast`, `errorToast`, `infoToast`, `warningToast`, `progressToast`, `loadingToast`; the only toast surface | `#comp-toast` | use |
| `progress`, `progress-ring`, `histogram-bars` | progress that moves only when the backend stage moves; small bars | `#comp-progress` | use |
| `system-message`, `message`, `bubble`, `chain-of-thought` | session transcript rows | | use |
| `marker` | a marker glyph | | internal |

## States

| Primitive | Job | Anchor | Status |
| --- | --- | --- | --- |
| `loading` | the spinner. Never an icon with `animate-spin` | `#states-action` | use |
| `skeleton` | a local element whose final shape is known; list rows while loading | `#comp-skeleton`, `#states-list` | use |
| `empty-state`, `empty-art`, `empty` | the empty state of a tab, folder or list; `EmptyArt` is its one art | `#pat-empty-state`, `#states-list` | use |
| `error-state` | a failed load, inside the host panel, with Try again | `#states-list` | use |
| `error-boundary` | the React error boundary | | use |
| `kortix-loader` | the pulsing mark (`ProjectPendingScreen` renders it) | | use |
| `text-shimmer`, `typing-animation`, `typed-title` | streaming text reveals, opacity only | | use |

## Identity and marks

| Primitive | Job | Anchor | Status |
| --- | --- | --- | --- |
| `user-avatar`, `entity-avatar`, `favicon-avatar`, `avatar` | a person, an entity, a site; the avatar part | `#pat-avatars` | use |
| `kortix-logo`, `kortix-asterisk`, `kortix-glyphs`, `pixel-kortix-mark` | the mark; the pixel mark is the agent everywhere | | art |
| `kortix-icons` | the semantic icon layer over Phosphor | `#icons` | use |
| `icon-provider` | the one icon weight (`DEFAULT_ICON_WEIGHT`) | `#icons` | use |
| `local-time` | a time in the viewer's zone | | use |

## Data and media

| Primitive | Job | Anchor | Status |
| --- | --- | --- | --- |
| `chart` | the chart ramp through `var(--chart-n)` | | use |
| `map` | a map | | use |
| `mermaid-renderer` | a Mermaid diagram | | use |
| `preview-image` | an image with a loading state | | use |
| `file-tree` | a file tree | | use |
| `wallpaper-shaders`, `paper-wallpaper-shaders`, `shader-safe` | WebGL wallpapers with a static fallback | `#wallpapers` | art |
| `dot-matrix/` | `SessionDotMatrix`, the session busy mark | | use |
| `menu-recipe` | `menuRow()`, `MENU_PANEL_STATIC`, `FLOATING_PANEL(_SURFACE)` | | internal |
| `trigger-variants` | shared trigger styles | | internal |

## Adding a primitive

1. `packages/ui/src/primitives/<name>.tsx`, relative imports only.
2. `pnpm --filter @kortix/ui gen-exports`.
3. One `Spec` on `/design-system` with a `SpecRow` per variant and, when it has
   states, a `SpecGrid` of them. Add the anchor to this index.
4. Strings through `useUiStrings()`, links through `useUiLink()`.
