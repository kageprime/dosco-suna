# Color scheme: how the Kortix palette is built

The values are in `.agents/skills/kortix-brand/references/visual/visual-system.json`
(`color.*`) and rendered live, light beside dark, at `/design-system#colors`.
The rules are `kortix-brand/references/visual/color.md`. This file is the
short version an agent reads before choosing a class: the structure of the
palette, not its numbers.

## The structure

Black and white carry the layout. One brand accent says where to look. Six
status hues say what happened. Nothing else has a hue.

```
canvas ─ pane ─ surface-1 ─ surface-2 ─ top surface        neutrals, by depth
ink ─ ink-muted                                              two inks, no third
hairline                                                     one border
kortix-base                                                  brand, focus, links
green · red · orange · yellow · blue                         status, one hue per meaning
purple                                                       the owner badge, nothing else
chart-1 … chart-5                                            data visualization only
```

## Neutrals: a ladder, not a palette

Every neutral is a step of lift from the canvas. Light mirrors each dark step's
distance from the canvas, so a token flips itself and no component writes
`dark:` for color (J-1, 2026-06-19).

| Step | Token | Job |
| --- | --- | --- |
| canvas | `--background` | the page |
| pane | `--pane` | the content pane inside the app shell |
| shell | `--surface` | one thing: a full-bleed pane standing in for the page |
| surface-1 | `--card`, `--accent`, `--sidebar` | a lifted region, the sidebar, a hover surface |
| surface-2 | `--secondary`, `--muted` | an inset control, a chip, a track, a tile fill |
| top surface | `--popover` | a field, an overlay, a row or panel inside a panel |
| ink | `--foreground` | primary text |
| ink-muted | `--muted-foreground` | descriptions, meta, idle state |
| hairline | `--border` | every content border |

Pick the lowest step that still separates the element from its ground. A
section that sits directly on the page is `bg-background` plus the hairline,
not a tint. In dark the sidebar row is surface-2, one step above light, and a
control on that row goes one more step up (J-2).

## Two inks

Hierarchy is surface lift, never text opacity. `text-foreground` is the first
read, `text-muted-foreground` the second. A third grey means the layout has one
level too many. `--foreground-weak` equals `--muted-foreground`; use the
semantic name.

## One brand accent

`--kortix-base` is the brand, the focus ring and the link color. It aliases
`--ring` (`--kortix-base: var(--color-ring)` in `globals.css`). Blue is a signal, never a solid fill: a 1px line, a ring, a glyph,
a link, or the `/15` "New" tint. Text selection is ink (`--primary` mixed into
transparent), not blue.

## Status: one hue per meaning (D5)

| Hue | Means | Never |
| --- | --- | --- |
| `kortix-green` | success, running, connected, merged | a label color |
| `kortix-red` | error, failed (a state that reports) | a destructive button (that is `--destructive`) |
| `kortix-orange` | warning, needs attention, a designed refusal where a person can act | info |
| `kortix-yellow` | pending, awaiting you | a count (a count is structure: neutral) |
| `kortix-blue` | info, open, in review | brand (that is `kortix-base`) |
| `kortix-purple` | the owner role badge (`Badge variant="royal"`) | anything else |

Accents are the same value in light and dark. They paint a glyph, a dot, a
`/15` tint or a chart, and the label beside them stays ink: every accent
measures 2.4 to 4.0:1 on white and fails AA as body text (J-7). Color is never
the only carrier: the word or the glyph shape repeats the meaning.

A filled status banner is `bg-kortix-*/15` with `border-transparent`; only the
neutral tone draws `border-border`. A tile has one boundary: a fill or a
hairline, never both.

## Interaction fills

`--hover` and `--active` are translucent ink (black in light, white in dark), so
they compose over any substrate. The sidebar row is the one solid exception.
Focus is `--ring`. Disabled is opacity, not a color swap.

## Light and dark

- One scope: the `dark` class on `<html>` (`@custom-variant dark`). A styleguide
  pane shows dark by wrapping the swatch in `dark`.
- A token flips itself. A `dark:bg-*` in a diff means the wrong token was
  chosen; fix the token in `visual-system.json`, not the call site.
- Shadows disappear on black, so every overlay pairs its shadow with a hairline.
- The segmented chip is raised (`bg-popover ring-1 ring-border shadow-xs`), not
  outlined twice, so it reads as the selected thing in both themes.
- Contrast is measured, not assumed: non-text UI parts need 3:1 (WCAG 1.4.11).
  Write the before and after ratio in the PR.

## Escape hatches

Three, and no fourth: a third-party brand color in a named constant beside the
component (a provider logo, an OAuth button, the white logo tile), raw color
inside an art module (`graphic-elements.md`), and the user-chosen glyph and
emoji palettes (`color.glyph`, `color.emoji`).

## Other families

- Chart ramp `--chart-1` to `--chart-5`: data visualization only, read through
  `var(--chart-n)`, theme-invariant.
- Terminal `color.terminal.*`: the PTY pane is shell-black in both themes.
- Mobile `success` and `warning` alias `kortix-green` and `kortix-orange` (J-4).

## Change a color

1. Edit `visual-system.json`.
2. `bun .agents/skills/kortix-brand/scripts/generate-tokens.ts`.
3. Update the guidance file that explains the value, and add a `decisions.md`
   entry.
4. Check `/design-system#colors` in light and dark, and
   `cd tests && npx vitest run --config unit/vitest.config.ts unit/brand-kit.test.ts`.
