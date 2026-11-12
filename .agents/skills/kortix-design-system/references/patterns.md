# Patterns: how a Kortix surface is structured

The component rules are in `SKILL.md`. This file holds the structural patterns
that apply to every screen, panel and block, whatever the component. Each one
is rendered on `/design-system` (anchors below). Rule format follows the brand
kit: **Rule.** — *Why:* — *Where:* — *When silent:*.

## 1. Parallel structure

**Rule.** Things of the same kind share one shape: the same slots, in the same
order, at the same size. A row of variants, a grid of states, a list of
settings, a set of cards. The label sits in one column, the thing in the other,
and every row uses the same column. — *Why:* a reader scans one edge and
compares. A block that changes shape per item makes the reader re-learn it per
item. — *Where:* app, marketing, the styleguide. — *When silent:* put the
label in a fixed left column (`sm:grid-cols-[7rem_minmax(0,1fr)]`) and the thing
on the right. `SpecRow` on `/design-system#comp-button` is the reference.

Don't:

```tsx
<div>
  <p className="text-xs uppercase tracking-wider">Base variants</p>
  <div className="flex gap-2">…</div>
</div>
<div>
  <h4>Sizes</h4>
  <p className="text-sm">Three sizes, use sm in rows.</p>
  <div className="flex gap-2">…</div>
</div>
```

Do:

```tsx
<SpecRow label="Base variants"><div className="flex gap-2">…</div></SpecRow>
<SpecRow label="Sizes" about="Three sizes. Rows use sm."><div className="flex gap-2">…</div></SpecRow>
```

## 2. No title, description, title, description

**Rule.** A block has one name and, if it needs one, one explanation behind an
info icon. It never stacks a title over a description over a sub-title over a
sub-description. A section heading does not repeat as an intro paragraph under
it. — *Why:* the stack is the default shape of generated UI. It costs a line per
level, and the reader reads the same fact twice. "Less textual information" is
the Jay bar (2026-11-07). — *Where:* app, marketing, the styleguide. — *When
silent:* name, then the thing. Put the sentence behind `InfoHint`. If the
sentence is a rule, it belongs in a skill file, not on the screen.

Don't:

```tsx
<h2>Members</h2>
<p>People and agents who can open this project.</p>
<h3>People</h3>
<p>Humans with a role.</p>
<ul>…</ul>
```

Do:

```tsx
<div className="flex items-center gap-1.5">
  <h2 className="text-xl font-medium">Members</h2>
  <InfoHint>People and agents who can open this project.</InfoHint>
</div>
<Label>People</Label>
<ul>…</ul>
```

## 3. Explain with an info icon, not a line

**Rule.** The explanation of a label, a setting or a block is an info icon
(`InfoIcon`, `size-3.5`, `text-muted-foreground hover:text-foreground`) that opens
a `HoverCard` on hover, on focus and on tap (controlled `open`; the tap is read
on `pointerdown` with `pointerType === 'touch'`, because a hover card opens for
mouse and keyboard only; a mouse click does nothing, so it never races the card's
hover and focus timers; a keyboard activation reopens after Escape; the card's
dismiss layer closes on an outside tap or Escape). Its name is "About {the thing}", and the content's `id`
is the trigger's `aria-describedby` while open. One sentence, two at most, `text-xs
text-muted-foreground`, `w-72`. A `Hint` (tooltip) is for the name of an
icon-only control; the info icon is for a sentence about a labelled thing. —
*Why:* the hover card is the one animated floating panel (motion.md, D4a), it
opens from its trigger, and it costs no line until asked. — *Where:* app. —
*When silent:* `InfoHint` in
`apps/web/src/app/[locale]/(public)/(marketing)/design-system/spec.tsx` is the
reference composition. In `packages/ui` compose `HoverCard` + `HoverCardTrigger
asChild` + a `<button aria-label>` + `HoverCardContent`. Rendered at
`/design-system#interaction-translate` ("Explain").

```tsx
const [open, setOpen] = useState(false);
const contentId = useId();

<HoverCard open={open} onOpenChange={setOpen} openDelay={150} closeDelay={100}>
  <HoverCardTrigger asChild>
    <button
      type="button"
      aria-label="About retention"
      aria-expanded={open}
      aria-describedby={open ? contentId : undefined}
      // A hover card does not open on touch; read the tap on pointerdown. Hover
      // and focus open through the card's own timers; a keyboard activation
      // (click with detail 0) reopens after Escape. A mouse click does nothing.
      onPointerDown={(e) => {
        if (e.pointerType !== 'touch') return;
        e.preventDefault();
        setOpen((v) => !v);
      }}
      onClick={(e) => {
        if (e.detail === 0) setOpen(true);
      }}
      className="text-muted-foreground hover:text-foreground inline-flex size-5 items-center justify-center rounded-sm transition-colors duration-fast"
    >
      <InfoIcon className="size-3.5" />
    </button>
  </HoverCardTrigger>
  <HoverCardContent id={contentId} side="top" align="start" className="text-muted-foreground w-72 text-xs leading-relaxed">
    Sessions older than the retention window are archived, not deleted.
  </HoverCardContent>
</HoverCard>
```

## 4. The four states of a list

**Rule.** Every list, tab and folder draws four states with one primitive each,
and nothing else. — *Why:* one picture per state reads the same on every
screen (D14, D4h, Q24). — *Where:* app. — *When silent:* the table. Rendered at
`/design-system#states-list`.

| State | Primitive | Shape | Never |
| --- | --- | --- | --- |
| Loading | `Skeleton` rows, the row's height | the row shape, no stagger | a spinner for a list; a skeleton of a page the route cannot draw |
| Empty | `EmptyState size="sm"` + `media={<EmptyArt icon={…} />}` | one title, one sentence ("{Plural noun} you create will show up here."), `Button variant="outline" size="sm"` with a leading glyph | another tile or illustration, a centred `<p>` alone |
| Error | `ErrorState size="sm"` | "Could not {verb} {object}." then a Try again action, no wrapper box | `Alert` for a load failure, raw JSON |
| Loaded | the rows | `bg-popover rounded-md border px-3 py-2`, status as a tinted tile with a glyph, label in ink | a hue on the label |

Page-level loading (no shell yet) is `ProjectPendingScreen`, the pulsing mark.

## 5. The four states of an action

**Rule.** A control that runs work shows idle, pending, done and disabled with
the same width and the same label. — *Why:* a label that changes or a spinner
that widens the button moves the row (#8491, #6952). — *Where:* app. — *When
silent:* the table. Rendered at `/design-system#states-action`.

| State | What changes | Code |
| --- | --- | --- |
| Idle | nothing | `<Button size="sm" variant="secondary"><PlusIcon className="size-3.5 shrink-0" />Save</Button>` |
| Pending | the glyph becomes `Loading`, the control is disabled and `aria-busy` | `{pending ? <Loading className="size-3.5 shrink-0" /> : <PlusIcon … />}` |
| Done | the glyph becomes a check in place; one `successToast('Saved')` | `<CheckIcon className="text-kortix-green size-3.5 shrink-0" />` |
| Disabled | `disabled:opacity-50`, pointer events off | `disabled` |

Success is a toast or an in-place glyph swap. It is never an inline "Saved"
line and never a green label.

## 6. Hover, press, focus

**Rule.** Hover changes color only (`hover:bg-hover`, `transition-colors
duration-fast`). Press is `active:scale-[0.96]` on a control and
`active:scale-[0.998]` on a full-width row, both behind `motion-safe:` and
added at the call site (`Button` does not ship a press scale). Focus is `focus-visible:ring-ring`,
never removed. Anything an arrow key drives, and every dense list, gets
`transition-none`. — *Why:* motion.md, the frequency ladder: hover is seen tens
of times an hour. — *Where:* app. — *When silent:* color only. Rendered at
`/design-system#interaction-states`.

## 7. Translate and swap

**Rule.** A position change is earned. A leading or trailing glyph may nudge
`translate-x-0.5` on hover at `duration-fast` on a marketing-profile link or a
page's one primary link, with `motion-reduce:transition-none
motion-reduce:group-hover:translate-x-0` so the glyph holds still under
reduced motion (or gate the whole nudge with `motion-safe:`). Never on a dense
row, a menu item, a sidebar row or a table cell. A state swap (copy to copied,
connect to connected) cross-fades two glyphs in one fixed box: scale `0.25 → 1`,
opacity `0 → 1`, blur `4px → 0`, spring `{ duration: 0.3, bounce: 0 }`,
`initial={false}`. — *Why:* `translate-x-0.5` ships in five files (`setup-wizard.tsx`,
`global-upgrade-modal.tsx`, `demo-qualifier-modal.tsx`, `capability-hero.tsx`,
`surface-page.tsx`), each on a primary or marketing link. The swap
is the sanctioned exception in `SKILL.md`. — *Where:* app, marketing. — *When
silent:* no translate; hard-swap the glyph. Rendered at
`/design-system#interaction-translate`.

## 8. Less text

**Rule.** A screen states the fact once, in the fewest words that name the
object. A button names its object ("Copy session ID"). An error names what
failed and the next action. An empty state is one title and one sentence. A
rule goes in a skill file, not on the screen. — *Why:* voice-and-tone.md
section 4. — *Where:* every surface. — *When silent:* delete the sentence. If the
screen still works, keep it deleted.

## Rationalization table

| Thought | Reality |
| --- | --- |
| "A description under the title helps the user" | It costs a line on every visit. Put it behind the info icon. |
| "This block is different, it needs its own layout" | Same kind, same shape. Change the content, not the slots. |
| "A spinner is fine for this list" | Skeleton rows, the row's height. |
| "Green text says success" | A check glyph in `kortix-green` and an ink label. |
| "A lift on hover feels alive" | Hover is color only. Tens of times an hour. |
| "The arrow nudge is tiny" | It is a translate. One primary link per page, marketing profile. |

## Metadata details

Use `InlineMetaTime` from `@kortix/ui/inline-meta` for relative timestamps. Pass the real timestamp as `date`. Use `Hint` from `hint.tsx`, never `HoverCard`, to show weekday, full date, time, and timezone on hover or focus. Never reconstruct a timestamp from relative text.

Use `InlineMetaHint` for a count only when the related items help the current task. Show those items in a vertical list with a bounded scroll area. Do not add a hover card to every count. Use the existing data; a preview is not a second fetch by default.

Use `Alert` from `@kortix/ui/alert` for inline notices. Compose `AlertTitle`, `AlertDescription`, and `AlertActions` as needed. Do not create another banner wrapper.
