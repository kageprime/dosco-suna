---
name: kortix-design-system
description: "Use when building or editing any visual surface in apps/web — a page, screen, list, card, badge, avatar, modal, form, empty state, toast, tooltip, table, or panel — and you need to know WHICH component to compose, which primitives are banned, and how a surface is structured (parallel slots, one name plus an info icon, the four states, hover is color only). Load kortix-brand first for the values (color, spacing, type, radius, motion budget); this file assumes those and covers components, layout shells, structural patterns, the token map and reference implementations. Source of truth: packages/ui/src/primitives, the live /design-system page (open it first), and references/."
---

# Kortix Design System

**Track this file:** `.agents/skills/kortix-design-system/SKILL.md`

**If you are touching a visual surface in `apps/web`, follow this.** This file owns **which component to compose**. It does not own values — see below.

> **Read [`kortix-brand`](../kortix-brand/SKILL.md) first.**
> It is the router for the Kortix look and voice. Its visual files
> (`color.md`, `typography.md`, `layout.md`, `effects.md`, `motion.md`) are the
> value law: the closed allowlist for every color, spacing step, type rung,
> radius, elevation, easing and duration, plus the rule on **whether to animate
> at all**. Its `decisions.md` records why each rule is what it is. This file
> assumes you know those values and shows you what to build with them.

## Companion skills — load all three

| Skill                                                                                                    | Owns                                                                                                                                                     | Wins when they conflict               |
| -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| [**kortix-brand**](../kortix-brand/SKILL.md)                                                             | The value allowlists, voice and claims. Color, spacing, type, radius, elevation, motion budget. Rejected defaults. `scripts/audit.sh`. Decision history. | **Values, copy and motion restraint** |
| **kortix-design-system** (this file)                                                                     | Components, layout shells, reference implementations, banned primitives                                                                                  | **Which component**                   |
| [**make-interfaces-feel-better**](../../../apps/web/.agents/skills/make-interfaces-feel-better/SKILL.md) | Polish: concentric radius, optical alignment, tabular nums, hit areas, font smoothing                                                                    | **Polish detail**                     |

A polish skill will always propose more motion than Kortix wants. `kortix-brand`
is the ceiling all three operate under. Corrections to earlier versions of this
file (the shadow ladder that never existed, the press value) are recorded in
[`decisions.md`](../kortix-brand/references/decisions.md), entries E1 and E2.

## The product look: read this before you lay out anything

Kortix product UI is a quiet, persistent system, not a set of pretty
one-offs. The look comes from discipline that repeats on every screen, not
from decoration. When a recipe below covers your screen, copy its structure
and classes (never its example data). When a later section of this file
disagrees with this one, this section wins.

### Measure in real pixels

Kortix sets `--spacing: 0.23rem`: one spacing step is 3.68px, not 4px. Every
size class is 8% smaller than stock Tailwind. Measured: `h-8` 29px, `h-10`
37px, `h-11` 40px, `h-12` 44px, `w-5` 18px, `w-16` 59px, `w-28` 103px,
`w-32` 118px, `w-36` 132px, `w-72` 265px. `text-xs` is 13px, about 7px per
character. Size a column from these numbers, never from a stock-Tailwind
habit.

### The ten laws

1. **Dense inside, calm outside.** Rows are compact (`text-sm` names, `text-xs`
   meta, `h-11` rows). The space between blocks is large and empty. Never
   compensate for a thin page with a big centered column, a hero title or
   padding.
2. **Hierarchy from ink and size, not from color, boxes or weight.** Three ink
   roles, nothing else:
   - **Name ink:** `text-foreground`, `font-normal`. Field values, and the
     names of rows that need attention (Needs review, Failed) or are
     selected. A live row is marked by its glyph, not by bright text.
   - **Title ink:** `text-foreground font-medium`. The page `<h1>`, a section
     heading, the selected row's name. At most one per row.
   - **Meta ink:** `text-muted-foreground`. Everything else: labels,
     timestamps, counts, context, descriptions, people, branches, durations.
     Meta ink is the default. Bright text is the exception: at most about a
     third of the visible names. **A row in a live or resting group
     (Running, Done, Archived) and a routine feed event write their name in
     meta ink too**, at the same size and geometry: the eye goes
     to the live work first. **Rail values are meta ink too**, except the
     status word: the rail is reference, not work.
   No `font-semibold` in product chrome below a detail-view title. No opacity
   on text (`text-foreground/60`).
3. **Edges are hairlines, not fills.** A group, a section and a list are
   separated by `border-border` 1px rules or by space. Never a filled bar
   (`bg-muted`) as a group header. Never a bordered panel around bordered
   inputs. Never a card per row. Count the nested boxes: more than one
   outline around any piece of text is a defect.
4. **Color only means state.** Hue appears only on a state glyph for a live
   or attention state (running, needs review, failed) and on diff counters,
   from `STATUS_TEXT` in `@kortix/ui/status`. A resting state (done, idle,
   archived) is meta ink: ten green checks down a list are noise, and the
   group header already says "Done". A person, a model, a trigger, an event
   type and a count never carry a hue. **No `UserAvatar` in product chrome
   outside a participant stack and a comment author:** its fill is a hashed
   hue. A person in a row, a rail or a field is their name in the ink the
   slot prescribes. Diff counters are the `DiffStat` primitive (`@kortix/ui/status`,
   `<DiffStat additions={38} deletions={6} className="text-xs" />`), never
   hand-built spans. The
   checked `Switch` is the one accent outside status; it is the primitive's,
   never restyle it.
   **An agent's name carries its pixel mark everywhere it appears** (page
   title, breadcrumb, agent rows, pickers): `AgentMark` from
   `@kortix/ui/internal/components/agent-mark`, `size={14}`, `shrink-0`,
   `gap-1.5` before the name. It is the agent's face, not a decoration; rail
   and facts-grid values still carry no glyph.
   **An object's own state words differ from its children's.** An agent or a
   trigger is Active, Paused or Archived; Running, Needs review and Done are
   the words of its sessions or runs. Never label the parent "Running", and
   a parent and its children never share a glyph or a hue: in a list
   row, the parent's Active is a `size-2 rounded-full bg-current` dot in meta
   ink (it is the normal state, not news; the rail shows only the word), Paused is `PauseCircleIcon` and Archived is
   `ArchiveIcon`, both in meta ink. `CircleDashedIcon` in
   `STATUS_TEXT.success` belongs to a child that runs now; green on a page
   means "running" and nothing else (diff counters aside).
5. **One grid per page.** One horizontal inset for every row, group header,
   tab bar and section on the page: `px-3`, the same as the page header. One
   row height per list. **One leading slot** (`flex w-5 shrink-0
   justify-center` plus the row's `gap-3`) on every row AND every header,
   so all text starts on one x. A header with no caret keeps the slot empty.
   Trailing columns have fixed widths, so values line up down the page.
   Every list on every tab of one page uses the same row. **A page has exactly
   two text edges:** chrome text (breadcrumb, tab labels, settings labels)
   starts on the inset (`px-3`, 11px), and list text (group headers, row
   names) starts on the inset plus the leading slot (about 40px). Measure the
   breadcrumb, the first tab label and a row name at 1440px: a third x value
   is a defect.
6. **The name owns the row.** The name column keeps at least half the row at
   every width. At most three trailing columns (an actor, and for objects
   that run, the duration and the relative end time). At most ONE secondary
   fact sits inline after the name (a branch or an ID, never a duration), in
   meta ink. Columns appear by the list's own width, never truncating at the
   same time as the name: the inline fact from `@xl/list` (576px), the
   people column from `@3xl/list` (768px). The name is `max-w-full shrink-0
   truncate`, so the fact gives up its space first.
   Identifiers (branches, repo slugs, IDs, paths) are `font-mono text-xs
   text-muted-foreground` on every surface: rows, feed context, rail, facts
   line. Never sans in one place and mono in another. Every row of one list
   carries the same inline fact or none. What hides below `lg` stays reachable
   on the row's destination. Never two columns from one fact (a duration and
   "12 minutes ago"), and never two facts in one column: a time column holds
   one value type in one format on every row. For objects that run (sessions,
   runs) it is the duration: elapsed time for a live row (`42m`), the final
   run length for an ended row (`22m`), `tabular-nums`; the exact start and
   end times are in its `InlineMetaTime` hint. For objects that do not run
   (docs, spaces) it is the relative time of the last change (`6m ago`).
   Never mix `8m` and `6m ago` in one column. An actor column holds actors only: a
   person's name, or an automation with a `size-3.5` meta-ink glyph before its
   name (`ClockIcon` Schedule, `WebhooksLogoIcon` Webhook), so the two kinds
   read apart. The cell is `flex items-center gap-1.5` with a `size-3.5
   shrink-0` slot on every row (an empty `<span>` for a person), so the text
   of the column starts on one x. A trailing column is as wide as its longest realistic
   value: the people column is `w-36` (132px): after its `size-3.5` slot and
   `gap-1.5` it holds about 16 characters of `text-xs`. Render the longest
   name in your data and confirm it has no ellipsis. A value that is not
   a person in a people column is one word ("Schedule", "Webhook"). A name
   that truncates at 1440px is a defect. **Nothing in the rail or the facts
   grid truncates:** prose wraps (`whitespace-normal break-words`) and
   identifiers wrap too (`font-mono text-xs whitespace-normal
   [overflow-wrap:anywhere]`). Only list rows truncate.
7. **Say it once.** The page header names the page. The body never repeats the
   name as a big heading with a description under it. A row never repeats its
   group (under a "Yesterday" header a row shows `09:14`, not "yesterday").
   No title over description over title. One sentence per empty state, at
   most 60 characters, so it fits 2 lines in `EmptyState size="sm"`.
8. **States keep the shape.** Loading draws the loaded layout in `Skeleton`
   (recipe below): same group headers, same row height, every column slot at
   its width. Counts and tabs stay mounted in every state and keep their
   width, so nothing shifts. On a first load nothing is known: a count is a
   `Skeleton` in the count's slot and a fact that comes from the list is a
   `Skeleton` too; never an invented value. **A tab's count slot never
   unmounts:** the trigger holds a fixed `inline-flex w-6 justify-end`
   slot; loaded puts `CountBadge` in it, loading a `Skeleton h-3 w-5 py-0`,
   and error the last known `CountBadge`, or a meta-ink `–` on a first-load
   error (the slot keeps its width and the underline ends at a glyph, never
   at blank space). Tab labels sit at the same x in all four states. Creating an
   object from any state shows the loaded list with the new row and the new
   count before the success toast. Empty and error states sit in the
   list area.
9. **Real data, specific copy.** Specific names, real identifiers, clock
   times. Copy is short and declarative, with no filler and no trailing period
   on titles. When a side panel shows one object, its row is the open row
   (`bg-active`, name in title ink); a page with no side panel has no open
   row. Copy that names an object reads it from the current data, so a
   rename updates it. Acronyms are uppercase in every string, mock titles
   included (API, CI, PR, SDK). State words keep their label case in prose
   ("Moved to Done"). An error names the user-level cause and what still
   works ("Release Captain keeps running its sessions."),
   never a status code or a retry count.
10. **Motion is feedback, not decoration.** Hover is a color change
    (`transition-colors duration-fast`). Lists appear at once. Nothing on a
    product page animates on load.

### Page width: by page type

| Page type | Content frame |
| --- | --- |
| List page (spaces, sessions, triggers, an inbox) | Full width of the pane, rows `px-3`, no `max-w-*`. A centered column truncates names and wastes 40% of the screen. |
| Detail page (a trigger, a goal, a space, an agent) | Full width: main column `min-w-0 flex-1` + a properties rail `w-72 border-l` at `lg:`. The work gets the width; the facts sit in the rail. |
| A settings tab inside a detail page | Left-aligned on the page inset: `w-full max-w-2xl px-3 pt-6 pb-16`, the rail stays. No `mx-auto`, no `py-10`. |
| A standalone settings page, a customize section | `mx-auto w-full max-w-2xl px-4 py-10` (the shell under "Layout & responsiveness"). |

The content of a list or detail page starts directly under the header row:
the tab bar or the first group header is the next line.

### Leading glyphs: one style, one glyph per state

Every leading glyph is a Phosphor icon at `size-4` in the `w-5` slot, at the
global weight (never a `weight` prop). One fixed glyph per state, never a
per-row pattern or seed:

| State | Glyph | Ink |
| --- | --- | --- |
| Running, live | `CircleDashedIcon` | `STATUS_TEXT.success` |
| Needs review, awaiting you | `GitPullRequestIcon` (code) or `EyeIcon` (anything else) | `STATUS_TEXT.warning` |
| Failed | `XCircleIcon` | `STATUS_TEXT.destructive` |
| Queued, idle | `CircleIcon` | meta ink |
| Done | `CheckCircleIcon` | meta ink |

**Feed events have a closed glyph table** (all `size-4`, meta ink unless a
colour is given):

| Event | Glyph |
| --- | --- |
| Started | `PlayIcon` |
| PR opened | `GitPullRequestIcon` |
| Asked for review | `GitPullRequestIcon` in `STATUS_TEXT.warning` |
| Merged | `GitMergeIcon` |
| Finished | `CheckCircleIcon` |
| Failed | `XCircleIcon` in `STATUS_TEXT.destructive` |
| Edited | `PencilSimpleIcon` |

Never `GitBranchIcon` for a PR event.

**One glyph, one ink, one meaning, on the whole page.** A state glyph keeps
its state ink everywhere it appears, list or feed: "Asked for review" in the
feed is the Needs review glyph in `STATUS_TEXT.warning`. No other event
borrows a state glyph outside the table above. **One hue, one meaning:**
blue is the checked `Switch` ("on") and nothing else on a page; orange is
"awaiting you"; green is "running"; red is "failed".
`ArrowSquareOutIcon` means "opens outside the app" and nothing else. List every glyph across all tabs before you hand back; each maps
to exactly one meaning.

`SolidCheckIcon` is the completion confirmation that swaps in after an action
(copy → copied); it is not a row state. `SessionDotMatrix` marks live work in
the session view, not in a list's leading slot.

### Recipe: list rows with groups

Example domain: the runs of a scheduled trigger. Copy the structure, not the
words.

```tsx
const LEAD = 'flex w-5 shrink-0 justify-center';
// The one separator, used in rows, feeds and facts. No spaces or flex gap around it.
const SEP = <span aria-hidden className="text-muted-foreground px-1.5">·</span>;

// The list fills the main column: <div className="@container/list w-full min-w-0 space-y-6">{groups}</div>
// No max-w-*: every hairline in the main column spans the tab bar's width, up to the rail.
<section>
  <div className="flex h-8 items-center gap-3 border-b border-border px-3 text-xs">
    {/* the toggle is only caret + name + count; column captions sit outside it */}
    <button
      type="button"
      onClick={toggle}
      aria-expanded={open}
      className="group/toggle flex h-full min-w-0 flex-1 items-center gap-3 self-stretch text-left"
    >
      <span className={LEAD}>
        <CaretDownIcon className={cn('text-muted-foreground size-3', !open && '-rotate-90')} />
      </span>
      <span className="text-foreground font-medium">Failed</span>
      <span className="text-muted-foreground tabular-nums">2</span>
    </button>
    {/* first group only: captions in the value slots */}
    {/* the caption carries the value's glyph slot, so its text starts on the values' x */}
    <span className="text-muted-foreground hidden w-36 shrink-0 items-center gap-1.5 @3xl/list:flex"><span className="size-3.5 shrink-0" />Started by</span>
    <span className="text-muted-foreground w-14 shrink-0 text-right">Duration</span>
    <span className="text-muted-foreground w-16 shrink-0 text-right">Ended</span>
  </div>
  {open ? (
    <ul>
      <li className="relative flex h-11 items-center gap-3 px-3 transition-colors duration-fast hover:bg-hover">
        <span className={LEAD}>
          <XCircleIcon className={cn('size-4', STATUS_TEXT.destructive)} />
        </span>
        {/* no gap-*: SEP's px-1.5 is the only space around the dot */}
        <Link href={runHref(run.id)} className="flex min-w-0 flex-1 items-baseline outline-none after:absolute after:inset-0 focus-visible:after:ring-2 focus-visible:after:ring-ring">
          {/* name ink only for attention groups (Needs review, Failed); meta ink for live and resting groups */}
          {/* the name never shrinks below its text; the fact takes what is left */}
          <span className="text-foreground max-w-full shrink-0 truncate text-sm">Post the weekly churn report to #revenue</span>
          <span className="text-muted-foreground hidden min-w-0 truncate font-mono text-xs @xl/list:inline">
            {SEP}run_8f2c41
          </span>
        </Link>
        <span className="text-muted-foreground hidden w-36 shrink-0 items-center gap-1.5 text-xs @3xl/list:flex">
          <ClockIcon className="size-3.5 shrink-0" />{/* a person gets <span className="size-3.5 shrink-0" /> */}
          <span className="truncate">Schedule</span>
        </span>
        <span className="text-muted-foreground w-14 shrink-0 text-right text-xs tabular-nums">2m 14s</span>
        <span className="text-muted-foreground w-16 shrink-0 text-right text-xs tabular-nums">
          {/* relative z-10 lifts the hint trigger above the stretched link; the hint shows the exact time */}
          <span className="relative z-10"><InlineMetaTime date={run.endedAt}>14m ago</InlineMetaTime></span>
        </span>
      </li>
    </ul>
  ) : null}
</section>
```

- Every row of an object list is one link (`after:absolute after:inset-0`)
  with the hover fill, so the whole row is clickable and keyboard focusable.
  In mock code, link to the route the object would have
  (`/projects/<id>/runs/<run_id>`). A row menu (⋯) is a sibling with
  `relative z-10`, see "List page rows" below. The row whose object is open
  beside the list shows `bg-active` and its name in title ink.
- Rows inside a group have no divider: the 40px rhythm and the hover fill
  separate them. Only the group header (`border-b border-border`) and the
  pane edges draw a hairline. A rule every 40px reads as ruled paper.
- Rows sort by the group's time column: a live group by longest elapsed
  first, every other group by most recent change first.
- The people column shows whenever the list itself is at least 48rem wide
  (`hidden @3xl/list:flex`), decided by the list's width, not the viewport.
- The first group header carries the trailing column captions ("Started
  by", "Duration", "Ended") in meta ink, in the same slots as the row values,
  outside the toggle button (a caption is not a control). Later group headers
  leave the slots empty. A caption's text starts on the same x as its
  values' text (measure: more than 1px off is a defect).
- **A cell never states something false.** A live row's "Ended" cell is a
  meta-ink `–` with `aria-label="Still running"`; its elapsed time is already
  in Duration. Never "now", never "running". Read every cell aloud with its
  caption ("Ended: now"): a false sentence is a defect.
- The group name is `text-foreground font-medium` inside an `h2` that names
  the group's `<section aria-labelledby>`; the caret, the count and the
  captions are meta ink. Each value cell carries its caption for screen
  readers (`<span className="sr-only">Duration </span>`).
- A row has one Tab stop: its link. At most one hint per row is focusable,
  and it holds every exact time (started and ended) in one `Hint`.
- Creating an object expands its group, scrolls the new row into view
  (`scrollIntoView({ block: 'nearest' })`), focuses its link, and only then
  calls `successToast`.
- The time column holds one value type (law 6). Rows sort by it: a live
  group by longest elapsed first, other groups by most recent end first.
- Group order is the order of urgency: the group that waits on the user
  first (Needs review, Failed), the live group second (Running), resting
  groups last (Done, Archived). Only the attention group uses name ink.
- A collapsed group keeps its header. A group with no rows is not drawn.
- Group counts are bare `tabular-nums` meta text. `CountBadge` is for a tab
  or a nav item, not a group header.

### Recipe: an activity feed

The same row and the same group header (without the caret: the slot stays,
empty). Example domain: a project's documents.

```tsx
<li className="relative flex h-11 items-center gap-3 px-3 transition-colors duration-fast hover:bg-hover">
  <span className={LEAD}>
    <PencilSimpleIcon className="text-muted-foreground size-4" />
  </span>
  <Link href={docHref} className="min-w-0 flex-1 truncate text-sm after:absolute after:inset-0">
    <span className="text-muted-foreground">Edited:</span>{' '}
    {/* routine event: object in meta ink; attention event (Failed, Asked for review): object in text-foreground */}
    <span className="text-muted-foreground">Pricing FAQ</span>
    {SEP}
    <span className="text-muted-foreground font-mono text-xs">rev 14</span>
    {/* a Finished event's context is <DiffStat additions={38} deletions={6} className="text-xs" /> */}
  </Link>
  <time className="text-muted-foreground w-16 shrink-0 text-right text-xs tabular-nums">09:14</time>
</li>
```

- **Every event glyph is meta ink.** Only a failure colors its glyph
  (`STATUS_TEXT.destructive`). "Started", "merged", "opened" are past events,
  not live states: never green, never the running glyph.
- **One type size per line:** the event phrase and the object are both
  `text-sm`; only a mono identifier is `text-xs`.
- **One grammar for every row:** `<event phrase>:` in meta ink, then the
  object's name, then ` · ` and one context fact. The colon keeps an
  imperative title from gluing onto the verb: "Moved to review: Pin the SDK
  in white-label apps", "PR opened: Bump the API client to 2.14", "Failed:
  Backport the webhook retry". Never "Merged Tag web 4.8.0…".
- **A closed vocabulary before the colon:** Started, Pushed, PR opened,
  Merged, Finished, Failed, Asked for review, Edited. A value (a duration, a
  count, a version) never goes in the phrase: it is the context fact after
  ` · `, or nothing. Consecutive events on one object within 10 minutes
  collapse into the later one.
- **A feed records state changes, not steps.** At most two events per
  object per day: its latest transition and, if different, its start.
  "Started" shows only for an object that is still running. Pushes fold into
  the next PR opened, Merged or Asked for review. At least half the rows are
  transitions (Asked for review, Merged, Finished, Failed).
- **An attention event** (Failed, Asked for review) writes its OBJECT name in
  name ink and keeps the phrase in meta ink, with the state glyph: the phrase
  repeats, the object does not. A routine event is all meta ink.
- **The context fact is the event's own artifact, never what the list row
  already shows:** `#4821` for PR opened, Merged and Asked for review, `+38
  −6` diff counters for Finished, the failing step for Failed ("e2e shard
  3"). A feed whose rows map 1:1 to list rows with the same fact is a defect.
  Drop a fact that repeats the event or the object ("Tagged web 4.8.0 ·
  v4.8.0"). Read each row aloud: a repeated word is a defect. At most one in three rows within each day group
  carries bright text, never two bright rows next to each other at the top;
  if the data breaks this, change the data. The failure must be the first
  thing the eye finds. Identifiers go after ` · `, never into the title.
  Capitalize acronyms in prose (API, PR); keep literal case in branch names
  and paths. An event that points to an object is a link, like a list row.
- Day groups (Today, Yesterday, Nov 19) use the group header with an empty
  leading slot. Rows under a day show a clock time.

### Recipe: a detail page

Example domain: one scheduled trigger.

```tsx
<div className="flex h-full min-h-0 flex-col">
  <ProjectPageHeader
    title="Weekly churn report"
    breadcrumb={
      <>
        <Link href={triggersHref} className="text-muted-foreground hover:text-foreground focus-visible:ring-ring shrink-0 rounded-sm text-sm outline-none focus-visible:ring-2">Triggers</Link>
        <CaretRightIcon className="text-muted-foreground size-3 shrink-0" aria-hidden />
      </>
    }
  >
    <Button size="sm" variant="secondary">Pause</Button>
    <Button size="sm"><PlayIcon className="size-3.5" />Run now</Button>
  </ProjectPageHeader>
  <Tabs defaultValue="runs" className="flex min-h-0 flex-1">
    <main className="flex min-w-0 flex-1 flex-col">
      {/* below lg: every rail fact, labelled, never clipped. It is page identity:
          it sits above the TabsList, under the header. */}
      <dl className="grid grid-cols-[4rem_minmax(0,1fr)_4rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 border-b border-border px-3 py-3 text-sm lg:hidden">
        <dt className="text-muted-foreground">Status</dt><dd className="text-foreground truncate">Active</dd>
        <dt className="text-muted-foreground">Schedule</dt><dd className="text-muted-foreground truncate">Mondays 09:00</dd>
        …
      </dl>
      <TabsList type="underline" className="h-10 w-full justify-start gap-4 border-b border-border px-3">
        <TabsTrigger value="runs" className="w-fit flex-none gap-1.5 px-0">
          Runs
          <span className="inline-flex w-6 justify-end">
            {count != null ? <CountBadge count={count} /> : loading ? <Skeleton className="h-3 w-5 py-0 motion-reduce:animate-none" /> : <span className="text-muted-foreground text-xs">–</span>}
          </span>
        </TabsTrigger>
        …
      </TabsList>
      <TabsContent value="runs" className="min-h-0 flex-1 overflow-y-auto pt-4">{/* groups, recipe above */}</TabsContent>
    </main>
    <aside className="hidden w-72 shrink-0 overflow-y-auto border-l border-border lg:block">
      <h2 className="text-muted-foreground flex h-10 items-center border-b border-border px-3 text-xs font-medium">Properties</h2>
      <DefinitionList className="px-3 py-3">
        <DefinitionRow label="Status" labelWidth={64}>
          {/* a word, no glyph: every rail value starts on one x */}
          <span className="text-foreground">Active</span>
        </DefinitionRow>
        <DefinitionRow label="Owner" labelWidth={64}><span className="text-muted-foreground">Ana Ruiz</span></DefinitionRow>
        <DefinitionRow label="Schedule" labelWidth={64}><span className="text-muted-foreground">Mondays 09:00</span></DefinitionRow>
        <DefinitionRow label="Repo" labelWidth={64}><span className="text-muted-foreground block font-mono text-xs leading-5 whitespace-normal [overflow-wrap:anywhere]">acme-analytics/warehouse-pipelines</span></DefinitionRow>
        <DefinitionRow label="Purpose" labelWidth={64}>
          <span className="text-muted-foreground block whitespace-normal break-words leading-snug">Posts churn by plan to #revenue</span>
        </DefinitionRow>
      </DefinitionList>
    </aside>
  </Tabs>
</div>
```

- The header is the identity. No icon tile, no `text-2xl` name, no
  description block in the body. A one-line purpose goes in the rail as a fact.
- The rail heading row has the tab bar's exact height (`h-10`) and the same
  `border-b`, so one hairline runs across the main column and the rail.
- **Rail geometry.** `w-72` rail, `px-3` (the page inset, so the rail adds
  no text edge), every `DefinitionRow` with
  `labelWidth={64}`: the value column is about 160px. Labels are one word of
  at most 8 characters. A status value is one word ("Running"); a count
  belongs in the tab, not in the status. **Rail and facts-grid values carry
  no glyph:** a glyph either pushes the text off the value edge (a third
  text start) or, hung outside, is clipped by `DefinitionRow`'s `truncate`.
  The status is its word, in name ink; the other values are meta ink. The value column
  holds about 22 characters of `text-sm` per line, so prose in the rail is
  at most 36 characters. **One order for the rail and the facts grid:**
  Status, Owner, Model, Repo, then the prose fact (Role or Purpose) last.
  Every rail value uses one 20px line box: identifiers are `font-mono text-xs
  leading-5`, so single-line rows sit on one pitch (±1px).
  Look at the screenshot: exactly 2 lines, no single-word last line, or
  shorten the data. The full text lives in Settings. Identifier values are `font-mono text-xs`. Read every rail value at 1440px with
  the real data: a clipped value is a defect.
- **Header actions follow state.** One eligibility function per object
  decides both which header buttons render and whether their handlers run:
  Active shows Pause + the primary action; Paused shows Resume + the primary
  action; Archived shows only Restore (no new work can be submitted, from the
  header, the empty state or a keyboard shortcut). An action that cannot
  apply is hidden, not disabled. When an action replaces itself (Pause →
  Resume), focus moves to the replacement; when it disappears (Archive),
  focus moves to the page `<h1>` (`tabIndex={-1}`).
- Below `lg`, a two-pair grid between the header and the tab bar carries
  every fact the rail shows, in the rail's exact order, with the same value
  treatments (status word in name ink, other values meta ink, mono
  identifiers): label in meta ink, two facts per line, pairs filled left to
  right, the prose fact last on its own line, so labels and values form
  columns. No fact is clipped and none is dropped; prose facts take a full
  line (`col-span-3` on the `dd`). Check it at 720px with the real values.
- **One frame on every tab.** Switching tabs never changes the header, the
  rail or the content edges. The rail stays on Settings and shows the saved
  values; it updates on save, not while typing.
- The tab bar stays put while the tab content scrolls: the `TabsList` sits
  outside the scroller, and each `TabsContent` is `min-h-0 flex-1
  overflow-y-auto`.
- Retry from an error goes back through the loading state, then loaded. It
  keeps every other URL parameter.
- Breadcrumb: every parent crumb is a real `Link` (`text-sm
  text-muted-foreground hover:text-foreground focus-visible:ring-2
  focus-visible:ring-ring`), never a `<span>`. The current page is the
  header's `<h1>`.
- Tabs: `TabsTrigger` takes `px-0` and the list `gap-4`, so the first label
  starts on the page inset and the underline is as wide as its label.
- The tab count stays mounted in every state with its last known count and
  the fixed `w-6 justify-end` slot, so "0" and "12" are one width and the tabs never
  shift.

### Recipe: a settings form

One grid for every field. Example domain: a trigger's settings.

```tsx
const FIELD_ROW = 'grid min-h-14 gap-2 py-2 sm:grid-cols-[12rem_minmax(0,1fr)] sm:items-center sm:gap-6';
const FIELD_ROW_TALL = 'grid gap-2 py-2 sm:grid-cols-[12rem_minmax(0,1fr)] sm:items-start sm:gap-6'; // label gets sm:pt-2.5

<div className="w-full max-w-2xl px-3 pt-6 pb-16 space-y-10">
  <section>
    <h2 className="text-foreground border-b border-border pb-3 text-sm font-medium">General</h2>
    <div className="pt-2">
      <div className={FIELD_ROW}>
        <Label htmlFor="name" className="text-muted-foreground text-sm font-normal">Name</Label>
        <Input id="name" size="md" defaultValue="Weekly churn report" />
      </div>
      <div className={FIELD_ROW}>
        <Label htmlFor="notify" className="text-muted-foreground text-sm font-normal">Notify on failure</Label>
        <div className="flex items-center gap-3"><Switch id="notify" /><span className="text-muted-foreground text-sm">Email the owner</span></div>
      </div>
      <div className={FIELD_ROW_TALL}>{/* a textarea keeps the label column; the label takes sm:pt-2.5 */}</div>
    </div>
  </section>
</div>
```

- No panel around the fields and no rule between field rows: a bordered
  input beside a hairline 10px away reads as ruled paper with boxes on it.
  The only rule is under each section heading. Rows are `min-h-14`, so a
  Switch row and an Input row are one height. Sections are `space-y-10` apart.
- One control height per form: `Input size="md"`, `SelectTrigger size="md"`
  and `Button size="lg"` (all `h-10`, 37px). Values in one control column
  start on one x: `Input` pads `px-3` and `SelectTrigger size="md"` pads
  `px-3.5`, so the trigger takes `className="px-3"`. A `Switch` sits at the start of the
  control column (`justify-self-start`), with any explanation beside it in
  `text-sm text-muted-foreground`. A label is one line of at most 24
  characters; a label never wraps. Every field keeps the label column,
  a textarea included (`FIELD_ROW_TALL`). A textarea sizes to its content
  (`field-sizing-content min-h-16`), never a fixed tall box.
- An invalid field says so where it is: `aria-invalid` on the control and a
  `FieldDescription` in `text-xs text-destructive` linked by
  `aria-describedby` ("Name is required"). A disabled Save with no visible
  reason is a defect.
- While Save runs, the form is locked (`<fieldset disabled={saving}>`), so
  no edit made during the save is overwritten by the saved copy.
- A `Switch` row's trailing text states the effect when on, in words the
  label does not use, at most 40 characters ("Waits for your approval to
  merge"). If it would repeat the label, omit it.
- A form's draft lives in the component that owns the tabs, above
  `TabsContent`, so switching tabs and back keeps unsaved edits. Its
  `ActionBarDock` and ⌘S binding exist only while the form tab is active.
- A section has at least two rows; a single setting joins the section
  above it. Danger zone is the exception and the last section.
- Danger zone: its row is the same `FIELD_ROW`: the action as the label in
  meta ink like every other label ("Archive trigger"), the button "Archive…" and
  `Button variant="outline" size="lg"` with `text-destructive` (`h-10`, the
  form's one control height) at the end of the control column. The consequence sentence goes in the `ConfirmDialog`
  it opens, not under the label. The solid `destructive` button lives only
  inside that dialog. No red panel, no red border.

### Recipe: the four states of a list

Column captions are labels, not data: the first skeleton group header shows
them as real meta-ink text in their slots, exactly as loaded; only the group
name and count are `Skeleton`. `Skeleton` has a built-in `py-4`: every bar
passes `py-0` or the bar is 30px tall, and `motion-reduce:animate-none` (it pulses forever otherwise). Each bar sits in the slot of the column it stands for. Draw every group
the list always shows (`GROUP_ORDER`): on a refresh, with each group's last
known count of rows; on a first load, three rows each. Title bars at three
widths, and a count bar in each group header.

```tsx
{state === 'loading' ? (
  <section aria-busy className="w-full min-w-0 space-y-6">
    {GROUP_ORDER.map((group) => ( // inside <section className="space-y-6">
    <div key={group}>
      <div className="flex h-8 items-center gap-3 border-b border-border px-3">
        <span className={LEAD}><CaretDownIcon className="text-muted-foreground size-3" /></span>
        <Skeleton className="h-3 w-20 py-0" />
        <Skeleton className="h-3 w-4 py-0" />
      </div>
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex h-11 items-center gap-3 px-3">
          <span className={LEAD}><Skeleton className="size-4 rounded-full py-0" /></span>
          <span className="flex min-w-0 flex-1 items-center gap-2">
            <Skeleton className={cn('h-3 py-0', ['w-64', 'w-80', 'w-48'][i])} />
            <Skeleton className="hidden h-3 w-24 py-0 @xl/list:block" />
          </span>
          <span className="hidden w-36 shrink-0 items-center gap-1.5 @3xl/list:flex"><span className="size-3.5 shrink-0" /><Skeleton className="h-3 w-20 py-0" /></span>
          <span className="flex w-14 shrink-0 justify-end"><Skeleton className="h-3 w-10 py-0" /></span>
          <span className="flex w-16 shrink-0 justify-end"><Skeleton className="h-3 w-12 py-0" /></span>
        </div>
      ))}
    </div>
    ))}
  </section>
) : state === 'error' ? (
  <ErrorState size="sm" className="py-16" title="Could not load runs" description="Weekly churn report keeps firing on schedule." action={<Button variant="outline" size="sm" onClick={retry}>Try again</Button>} />
) : runs.length === 0 ? (
  <EmptyState size="sm" className="py-16" media={<EmptyArt icon={ClockIcon} />} title="No runs yet" description="Runs appear here after you press Run now." />
) : (
  groups
)}
```

- Count every empty and error sentence AFTER substituting the longest real
  object name: over 60 characters, drop the name. "Work already running on
  Release Captain continues in the background." is 68 characters, 3 lines,
  a defect. The empty sentence names the committed action that creates the
  first object (sending the task), not the button that opens a composer.
- Empty copy: one sentence of at most 60 characters. When the header shows
  the primary action, the empty state has no button and the sentence names
  that action ("Runs appear here after you press Run now."); otherwise it
  says when objects appear ("Runs appear here after the schedule fires.").
  No noun appears twice in the sentence, counting the quoted button label:
  with a "New task" button, "Sessions appear here after you start a task."
  is right; "Start the first task with New task." is a defect. It carries `Button variant="outline"
  size="sm"` only when the header has no primary action. Two identical calls
  to action on one screen are a defect. Every action that creates an object adds it to
  the list and updates the count, in every state.
- Error copy: a title with no period and one meta sentence of at most 12
  words that adds what the title does not: the consequence or what still
  works. Its subject is the object, never a pronoun ("Their sessions…"). It
  never promises that a retry succeeds. First-load error (no rows on
  screen): "Weekly churn report keeps firing on schedule." Refresh error
  with last-known rows still shown: "These runs may be out of date." Never
  call a list stale when no list is drawn. Never a sentence that
  restates the title ("The runs did not arrive"), never "Something went wrong".
- The list area is one panel that stays mounted across loading, error and
  loaded, with `aria-busy` while loading. Each tab owns its own panel ref;
  Retry moves focus to the panel of the tab that retried (`tabIndex={-1}`)
  the moment it is pressed, because the button it came from unmounts.
- Each tab writes its own error sentence about its own object. Never one sentence copied across
  tabs.
- A route that cannot draw its shell yet uses `ProjectPendingScreen` as its
  `Suspense` fallback, never `null` (a blank page).
- An async button keeps its width: one fixed `size-4 shrink-0` slot holds the
  glyph, and `Loading` swaps into that slot while pending. While a `Modal`
  submits, Cancel is `disabled`, the corner close is hidden
  (`showCloseButton={!pending}`) and `onOpenChange` ignores a close.
- A state forced by the URL (`?state=`) is read with `useSearchParams()`.
  When retry or creation leaves that state, remove only `state`
  (`router.replace(…, { scroll: false })`) and keep every other parameter.
- A date-grouped feed's skeleton reuses the last known group and row counts;
  on a first load, the same three groups as the list.
- Mock data is one moment and one fixture: every tab reads the same objects.
  A feed event agrees with the list (a failed run sits in the Failed group);
  an empty list means an empty feed too.
- Empty and error sit at the top of the list area (`py-16`), not centered in
  the viewport.

### Self-check before you hand back (measure, do not eyeball)

1. Group headers, day headers and row names start on the same x; the leading
   glyph and the caret share one `w-5` slot.
2. No name and no rail prose truncates at 1440px. At 720px, names keep at
   least half the row and every fact in the facts line is readable whole.
   Only two text edges: the inset (11px) and the list edge (about 40px).
3. Count the hues on the screen. Each one maps to a live or attention state.
   A person, an avatar fill, a model, an event type or a decoration with a hue
   is a defect.
4. Count the outlines around any one word. More than one is a defect.
5. Count the title-ink elements per row: more than one is a defect. Count the
   bright names: more than the live, attention and selected rows is a defect.
6. Loading, empty and error keep the tab bar, header and counts in place and
   at the same width: compare the x of every tab label across the four state
   screenshots. Every skeleton bar is `py-0`, sits in its column, and the
   title bars have three different widths.
7. No `mx-auto max-w-2xl`, `py-10` or `lg:py-20` on a list or detail page.
8. Every full-row link goes somewhere real.
9. None of your copy or data was copied from this file's examples.
10. Read every rail value at 1440px and every fact at 720px with the real
    data. A clipped value, an empty count slot or a disabled header action
    that cannot apply is a defect.
11. Every glyph on every tab maps to one meaning; every acronym is uppercase;
    every group is sorted by its time column.
12. Read each feed row against its list row: same state, same moment. And at
    720px, no row truncates its name while its inline fact still shows.

## Start here: the rendered truth

**Follow the Kortix design system.** Every component, token and pattern below is
rendered at `/design-system` (`apps/web/src/app/[locale]/(public)/(marketing)/design-system/`).
The page paints each swatch with the real token and measures the value back, so
it cannot drift from `globals.css`. Open it before you build, copy what you see,
and when you add a component add it there too.

| Section                              | Anchor                                        | What it shows                                                                        |
| ------------------------------------ | --------------------------------------------- | ------------------------------------------------------------------------------------ |
| Colors                               | `#colors`                                     | the surface ladder, the core palette, the accents, the chart ramp, light beside dark |
| Token map                            | `#tokens`                                     | job → class → token → live value, by family                                          |
| Typography, Spacing, Shadows, Motion | `#typography` `#spacing` `#shadows` `#motion` | the rungs, steps, ladder and durations, measured                                     |
| States                               | `#states`                                     | the four states of a list and of an action, side by side                             |
| Interaction                          | `#interaction`                                | hover, press, focus, the glyph nudge, the icon swap, the info icon                   |
| Components                           | `#components`                                 | one `Spec` per primitive, one `SpecRow` per variant                                  |
| Patterns, Anti-patterns, Usage       | `#patterns` `#anti-patterns` `#usage`         | page patterns, the banned list, do and don't                                         |

The prose behind the page is in `references/`:
[`patterns.md`](references/patterns.md) (structure, states, hover, translate, the info icon),
[`token-map.md`](references/token-map.md) (every job → class → token),
[`color-scheme.md`](references/color-scheme.md) (how the palette is built),
[`component-index.md`](references/component-index.md) (every primitive, its job, its anchor).

## Spec grammar: how a surface explains itself

The rules in [`references/patterns.md`](references/patterns.md), in short. They
apply to product UI, not only to the styleguide.

- **Parallel structure.** Things of one kind share one shape: the same slots in
  the same order at the same size. A label sits in one fixed column and the
  thing in the other, so a reader scans one edge (`SpecRow`,
  `sm:grid-cols-[7rem_minmax(0,1fr)]`). Never a block that changes shape per
  item.
- **No title, description, title, description.** A block has one name and, if
  it needs one, one explanation behind an info icon. A section heading never
  repeats as an intro paragraph under it. If the sentence is a rule, it belongs
  in a skill file, not on the screen.
- **Explain with the info icon.** `InfoIcon size-3.5` in a `<button aria-label>`
  that opens a `HoverCard` (`w-72 text-xs text-muted-foreground`) on hover and on
  focus. `Hint` names an icon-only control; the info icon explains a labelled
  thing. Reference: `InfoHint` in the route's `spec.tsx`; rendered at
  `#interaction-translate`.
- **The four states, one primitive each.** List: `Skeleton` rows, `EmptyState`
  - `EmptyArt`, `ErrorState` with Try again, the rows. Action: idle, pending
    (`Loading` replaces the glyph, `aria-busy`, disabled, same label), done (a
    check swaps in place, one `successToast`), disabled (`opacity-50`). Never an
    inline "Saved" line, never a green label, never a spinner for a list.
- **Hover is color only.** `hover:bg-hover transition-colors duration-fast`.
  Press `active:scale-[0.96]`. Focus `ring-ring`. Dense lists and anything an
  arrow key drives: `transition-none`. `Button` does not ship the press scale; add it
  at the call site, behind `motion-safe:`.
- **Translate is earned.** A glyph may nudge `translate-x-0.5` at
  `duration-fast` on a marketing-profile link or a page's one primary link, with
  a reduced-motion branch. Never on a row, a menu item or a cell. A state swap
  is the icon-swap morph below.
- **Less text.** State the fact once, name the object, cut the adjective.

## Where components live: `@kortix/ui`

- **One component source.** Every primitive is in `packages/ui` (`@kortix/ui`):
  `packages/ui/src/primitives/<name>.tsx`, helpers in `packages/ui/src/lib/`,
  hooks in `packages/ui/src/hooks/`, the session thread in `packages/ui/src/session/`
  (`@kortix/ui/session`). `apps/web`, Kortix Apps, the white-label demo and SDK hosts
  render the same files (decision K9 in [`decisions.md`](../kortix-brand/references/decisions.md)).
- **Import the package path.** apps/web imports `@kortix/ui/<name>` for a primitive
  and `@kortix/ui/<entry>` (`session`, `files`, `workspace`, …) for a module. apps/web
  has no re-export shims: `tests/unit/web-no-ui-shims.test.ts` fails on a file that only
  re-exports `@kortix/ui`. Edit the component in `packages/ui`.
- **Mock the file the import resolves to.** bun mocks by resolved file:
  `mock.module('@kortix/ui/<name>')` reaches the primitive for apps/web and for the
  package files that import it relatively. A barrel import (`@kortix/ui`,
  `@kortix/ui/session`) loads every module of the barrel, so a partial mock of one of
  them must keep the module's other exports:
  `const real = await import('@kortix/ui/button'); mock.module('@kortix/ui/button', () => ({ ...real, Button: Stub }))`.
- **A new primitive** goes in `packages/ui/src/primitives/` with relative imports
  only (never `@/`, never `next/*`, never an app store), then
  `pnpm --filter @kortix/ui gen-exports`. apps/web imports it as `@kortix/ui/<name>`.
  Copy for the user goes through `useUiStrings()`; a link goes through
  `useUiLink()`. `npx shadcn add <x>` in `apps/web` writes into
  `apps/web/src/components/ui/` (`apps/web/components.json`): move the file to
  `packages/ui/src/primitives/`, rewrite its imports to relative paths, and import it
  from `@kortix/ui/<name>`.
- **Outside `apps/web`** (a Kortix App, an SDK host): follow the package skill,
  [`packages/ui/skills/kortix-ui/SKILL.md`](../../../packages/ui/skills/kortix-ui/SKILL.md).
  A dashboard or App over Kortix sessions:
  [`references/custom-dashboard.md`](../../../packages/ui/skills/kortix-ui/references/custom-dashboard.md).
  `kit.css` (`k-*` classes) is only for plain HTML without React.

## Philosophy

- **Simplicity is the brand.** Black & white + one accent. Calm, spacious, legible. No decoration that doesn't carry information. Show only important data.
- **Reuse > Compose > Create.** In that order. Never hand-roll something the system already provides.
- **Tokens are law.** `apps/web/src/app/globals.css` (the `:root` / `.dark` tokens) and `packages/ui/src/styles/theme.css` (the `@theme inline` keys, `@utility` definitions, keyframes and spinner classes that `@kortix/ui` components use) are the implementation source of truth for every visual property. If a value conflicts with anything else, these two files win.
- **Fast, or none.** Kortix is a speed product. Motion exists to make the UI feel _faster_ and to say where a thing came from — never to be admired. The more you animate, the less each animation is worth. The default answer to "should this animate?" is **no**.
- **AI-native & self-documenting.** The living styleguide at `/design-system` renders every component. When you add a component, add it there too.

## Strictly avoid — deprecated primitives

**Do not use these in new work or when refactoring screens.** They are legacy wrappers; match the hand-composed patterns in the customize section views instead.

| Banned                                                                                                                                       | Use instead                                                                                                                                                                                                                                                                                  |
| -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`SectionCard`** (`packages/ui/src/primitives/section-card.tsx`)                                                                            | `Card` (`card.tsx`), `Label` + `bg-popover rounded-md border` panel, or `Disclosure` — see `project-settings-page.tsx`                                                                                                                                                                       |
| **`List` / `ListRow`** (`packages/ui/src/primitives/list.tsx`)                                                                               | In a modal, popover or sheet: one grouped container (see _Grouped rows_). On a page: hairline rows, "Recipe: list rows with groups" in The product look                                                                                                                                                                                                |
| **`Dialog` / `DialogContent`** in feature code                                                                                               | **`Modal`** from `packages/ui/src/primitives/modal.tsx` — see `secrets-view.tsx`, `channels-view.tsx`                                                                                                                                                                                        |
| **`Tooltip` / `TooltipTrigger` / `TooltipContent`** in feature code                                                                          | **`Hint`** from `packages/ui/src/primitives/hint.tsx`                                                                                                                                                                                                                                        |
| **`@/lib/toast`** (deleted; never recreate it), raw `sonner`, `toast.success/error/info/warning()`, `toast.custom()`                         | Named helpers from `packages/ui/src/primitives/toast.tsx`. An action button is the `button` option (a `Button`), not sonner's `action`. `tests/unit/toast-single-source.test.ts` fails on any other `sonner` import                                                                          |
| Hand-rolled badge `<span>` chips                                                                                                             | **`Badge`** from `packages/ui/src/primitives/badge.tsx`                                                                                                                                                                                                                                      |
| A count beside a label (row, tab, menu item, button) as muted text or a `Badge`                                                              | **`CountBadge`** from `packages/ui/src/primitives/count-badge.tsx`: the sidebar Review-count recipe (tabular pill, row text colour, 15% tint, `99+`). Tone by meaning: `waiting`, `reminder`, `conflict`, `neutral`. Mobile: `CountBadge` in `apps/mobile/components/kortix/count-badge.tsx` |
| **Any icon as a spinner** — `CircleNotchIcon`, `SpinnerIcon`, `SpinnerGapIcon`, or the same glyph aliased to `Loader`/`Loader2`/`IconLoader` | **`Loading`** from `packages/ui/src/primitives/loading.tsx` — the spinner. The one other busy mark is `SessionDotMatrix`, for session-scoped work only (D4f in `decisions.md`)                                                                                                               |
| Hand-rolled `<svg>` spinners, `animate-spin` on non-`Loading` elements                                                                       | **`Loading`** — animation is built in                                                                                                                                                                                                                                                        |
| `@radix-ui/*`, `radix-ui`, `cmdk`, `vaul` anywhere on web (`tests/unit/no-radix-on-web.test.ts` rejects them); a direct `@base-ui/react` import in feature code | The `@kortix/ui` primitive (Base UI runs underneath); `asChild` on its parts, `Slot` from `@kortix/ui/slot` |

When editing a file that already uses banned primitives, migrate to the reference pattern — do not add more usage.

## Required primitives — use these, not alternatives

These are **mandatory** for their job. Import from the paths below; never reimplement or swap in a different library.

| Job                        | Import from                                                                      | Notes                                                                                                                                                                                                                                                                                                                                            |
| -------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Tooltips on icon buttons   | `packages/ui/src/primitives/hint.tsx`                                            | `<Hint label="…">…</Hint>` — wraps trigger, never Tooltip in features                                                                                                                                                                                                                                                                            |
| Dialogs / sheets           | `packages/ui/src/primitives/modal.tsx`                                           | `Modal`, `ModalContent`, `ModalHeader`, `ModalTitle`, `ModalDescription`, `ModalBody`, `ModalFooter`                                                                                                                                                                                                                                             |
| Toasts                     | `packages/ui/src/primitives/toast.tsx`                                           | The only toast surface. `successToast`, `errorToast`, `infoToast`, `warningToast`, `progressToast`, `loadingToast`, `dismissToast`                                                                                                                                                                                                               |
| Status chips               | `packages/ui/src/primitives/badge.tsx`                                           | `size="sm"` or `size="xs"`; variants `outline`, `kortix`, `success`, `destructive`, `beta`, etc.                                                                                                                                                                                                                                                 |
| Expand/collapse panels     | `packages/ui/src/primitives/disclosure.tsx`                                      | `Disclosure`, `DisclosureTrigger`, `DisclosureContent` — config lists, settings groups                                                                                                                                                                                                                                                           |
| Inline alerts              | `packages/ui/src/primitives/alert.tsx`                                           | `tone` + optional `icon` + `title`                                                                                                                                                                                                                                                                                                               |
| Search fields              | `packages/ui/src/primitives/input-group.tsx`                                     | `InputGroupSearch` + `InputGroupSearchInput`. Every input is the one field surface: `bg-popover`, border, `rounded-md`. `variant="popover"` is deprecated and ignored (D4j)                                                                                                                                                                      |
| Forms in panels            | `packages/ui/src/primitives/field.tsx`                                           | `Field`, `FieldLabel`, `FieldGroup`, `FieldDescription`                                                                                                                                                                                                                                                                                          |
| Empty / error states       | `packages/ui/src/primitives/empty-state.tsx`, `empty-art.tsx`, `error-state.tsx` | The empty state of a tab, a folder or a list: `EmptyState` + `media={<EmptyArt icon={…} />}` (stacked cards, one Phosphor glyph), one title, one sentence, outline buttons with icons. No other decorative tile (D14, 2026-10-25)                                                                                                                |
| Confirm destructive        | `packages/ui/src/primitives/confirm-dialog.tsx`                                  | **Mandatory before any destructive mutation** — including `DropdownMenuItem variant="destructive"` items (see `secrets-view.tsx` delete, `sections/view/gateway/gateway-keys.tsx` revoke). Only accepted alternative: the inline Cancel/confirm button swap used for channel disconnects (`channels-view.tsx`). Never mutate from a single click |
| Loading / pending spinners | `packages/ui/src/primitives/loading.tsx`                                         | `import Loading from '@kortix/ui/loading'` — default `size-4`; use `className="size-4 shrink-0"` in dense buttons. **Never** `CircleNotchIcon`, `SpinnerIcon`, or other icons                                                                                                                                                                    |

Also reach for: `Button`, `ButtonGroup`, `Input`, `Select`, `Switch`, `Skeleton`, `Tabs` / `TabsList size="xs"`, `Table`, `InlineMeta`, `UserAvatar`, `EntityAvatar`.

## Which component for which state

Paths are written in full. The values and the copy are in `kortix-brand` (`layout.md` sections Shells and States, `voice-and-tone.md` section 4).

| Situation                                                         | Compose                                                                                                                                                                                                                                                                              | Never                                                                                                   |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| The route has not mounted its shell (sign-in, project switch)     | `ProjectPendingScreen` (`apps/web/src/components/projects/project-pending-screen.tsx`)                                                                                                                                                                                               | A skeleton of a page you cannot draw                                                                    |
| A list loads inside a mounted shell and the row shape is known    | `Skeleton` rows                                                                                                                                                                                                                                                                      | A spinner for a list                                                                                    |
| A page or list failed to load                                     | `ErrorState size="sm"` (`packages/ui/src/primitives/error-state.tsx`) inside the host panel, with a "Try again" action                                                                                                                                                               | `Alert` for a load failure, or a wrapper box around it                                                  |
| An inline alert in a view that did load (a connection, a warning) | `Alert` with a `variant`                                                                                                                                                                                                                                                             | A hand-colored banner                                                                                   |
| A tab, a folder or a list has no items                            | `EmptyState` with `media={<EmptyArt icon={…} />}` (`packages/ui/src/primitives/empty-art.tsx`): one title, one sentence, `Button variant="outline" size="sm"` actions with a leading icon. An empty folder passes no glyph. A search with no result uses `MagnifyingGlassIcon` (D14) | Any other icon tile or illustration, a card, a forked or restyled `EmptyArt` / `EmptyState`, a new prop |
| People and agents with a role                                     | `AccessRow` (`packages/ui/src/access/access/access-row.tsx`), grouped "People" then "Agents" under a `Label`                                                                                                                                                                         | A hand-built `li`, a kind badge, a `[&>div]:` selector                                                  |
| Any form field, in a panel or in a `Modal`                        | `Field`, `FieldLabel`, `FieldGroup` (`packages/ui/src/primitives/field.tsx`)                                                                                                                                                                                                         | A raw `<label>` beside an `Input`                                                                       |
| A mutation finished                                               | `successToast` or `errorToast` from `packages/ui/src/primitives/toast.tsx`                                                                                                                                                                                                           | An inline "Saved" line                                                                                  |
| Rows are selected for a bulk action                               | `SelectionBar` (`packages/ui/src/internal/selection/selection-bar.tsx`), an `ActionBar` with the count and Select all, in an `ActionBarDock`. See "Floating action bar" below | Bulk buttons in a toolbar, a section heading or a table header |
| A page has unsaved edits, or a pending paste or move              | `ActionBar` (`@kortix/ui/action-bar`) in an `ActionBarDock`: title, muted description, Discard + Save `kbd: '⌘S'`. See "Floating action bar" below | A hand-built `bg-popover … shadow-md` bar, a sticky footer, a Save button in the header |
| A new capability page                                             | `CapabilityPageShell`                                                                                                                                                                                                                                                                | `CustomizeSectionWrapper` (legacy, `packages/ui/src/customize/sections/view/` only)                     |

## Reference implementations — customize section views

**Read the closest match before building any new screen.** Paths are written in
full; the customize views live in `packages/ui/src/customize/`.

| File                                                                        | Pattern to copy                                                                                                                                                               |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`packages/ui/src/customize/sections/component/section-wrapper.tsx`**      | Section shell: title left, action right, `max-w-2xl`, responsive header                                                                                                       |
| **`packages/ui/src/customize/agents/agents-page.tsx`**                      | Config entity list: search → rows → detail aside with `Badge`, `ButtonGroup` + `Hint`, toasts                                                                                 |
| **`packages/ui/src/customize/skills/skills-page.tsx`**                      | Capability page in `CapabilityPageShell`; `EmptyState` with a docs link                                                                                                       |
| **`packages/ui/src/customize/project-settings/project-settings-page.tsx`**  | Form sections: `Label` header → `bg-popover rounded-md border px-4 py-5` panel; `Disclosure` for experimental; danger zone as neutral bordered row                            |
| **`packages/ui/src/customize/sections/view/secrets-view.tsx`**              | `Table` + `TabsList size="xs"` filters + **`Modal`** forms + `DropdownMenu` row actions                                                                                       |
| **`packages/ui/src/access/access/access-row.tsx`**                          | Entity rows, `UserAvatar`, `InlineMeta` — the single row used by every access surface                                                                                         |
| **`packages/ui/src/workspace/review/review-detail.tsx`**                    | Tinted `size-9` icon tile (`bg-kortix-green/15` and `bg-kortix-orange/15`), `Badge size="sm"` verification chips                                                              |
| **`packages/ui/src/workspace/sessions/project-sessions-view.tsx`**          | `TabsList size="xs"` filter tabs                                                                                                                                              |
| **`packages/ui/src/customize/sections/view/channels-view.tsx`**             | `Table` for integrations, `Modal` for connect flows, `Alert` for connected state                                                                                              |
| **`packages/ui/src/internal/tunnel/computer-connect.tsx`**                  | Split art modal (beams art beside the content), pinned `lg` actions, one copy button that swaps to a check in place (#8491)                                                   |
| **`packages/ui/src/markdown/setup-links/connector-handshake.tsx`**          | Handshake tile: a catalogue logo fills its tile, a drawn mark takes one hairline (one boundary per tile, #8421)                                                               |
| **`packages/ui/src/primitives/tabs.tsx`**                                   | Segmented `TabsList` (the default): recessed track, raised chip, concentric radii, `p-[2px]` pixel snap (D4b, D4c)                                                            |
| **`packages/ui/src/primitives/menu-recipe.ts`**                             | Menu row grid; `MENU_PANEL_STATIC` and `FLOATING_PANEL_SURFACE` are instant, `MENU_PANEL` and `FLOATING_PANEL` are for the hover card (D4a)                                   |
| **`apps/web/src/components/projects/project-pending-screen.tsx`**           | The page-level loading mark (D4h)                                                                                                                                             |
| **`packages/ui/src/primitives/dot-matrix/session-dot-matrix.tsx`**          | The session busy mark (D4f)                                                                                                                                                   |
| **`packages/ui/src/primitives/empty-art.tsx`**                              | The empty state art of a tab, a folder or a list, composed in `packages/ui/src/workspace/spaces/space-links.tsx` (D14)                                                        |
| **`packages/ui/src/primitives/pixel-kortix-mark.tsx`**                      | The pixel Kortix mark (D4g). Not an empty-state art for a tab, a folder or a list (D14)                                                                                       |
| **`apps/web/src/features/workspace/command-palette.tsx`**                   | Instant palette, `PaletteEmpty` one-line empty state                                                                                                                          |
| **`apps/web/src/app/[locale]/(public)/(marketing)/design-system/spec.tsx`** | The Spec grammar: `Spec` (name, info icon, source), `SpecRow` (label column + thing), `SpecGrid` / `SpecCell` (parallel states), `InfoHint` (the info icon with a hover card) |
| **`…/design-system/states-section.tsx`**                                    | The four states of a list and of an action, each with its primitive                                                                                                           |
| **`…/design-system/interaction-section.tsx`**                               | Hover (color only), press, focus, the glyph nudge, the icon swap, the info icon                                                                                               |
| **`…/design-system/token-map-section.tsx`**                                 | Job → class → token → live value; the measured twin of `references/token-map.md`                                                                                              |

**Shells:** `packages/ui/src/customize/shared/capability-page-shell.tsx` (`CapabilityPageShell`)
is the current shell for capability pages. The older `CustomizeSectionWrapper`
(`packages/ui/src/customize/sections/component/section-wrapper.tsx`) still backs the
`packages/ui/src/customize/sections/view/*` screens.

**Other references:** tinted-icon tiles → `packages/ui/src/customize/triggers/schedule-view.tsx`; sidebar → `packages/ui/src/workspace/sidebar/project-sidebar.tsx`.

## Layout & responsiveness

**This shell is for settings and customize forms only.** A list page or a
detail page uses `ProjectPageHeader` and the full-width frame in "Page width:
by page type" above, never this centered column.

**Always wrap a settings or customize section in the shell its tree already uses** — `CapabilityPageShell`
for a capability page, `CustomizeSectionWrapper` under `packages/ui/src/customize/sections/view/`.
Do not hand-roll the outer shell.

Canonical pattern for a settings section (from `section-wrapper.tsx`):

```tsx
<div className="flex h-full min-h-0 flex-col">
  <div className="min-h-0 flex-1 overflow-y-auto">
    <div className="mx-auto w-full max-w-2xl space-y-5 px-4 py-10 pb-20 lg:py-20">
      <header className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <h2 className="text-foreground text-xl font-medium">{title}</h2>
          <span className="flex items-center gap-1">
            <p className="text-muted-foreground text-sm text-balance">
              {description}
            </p>
            {/* optional docs link: Button variant="transparent" asChild */}
          </span>
        </div>
        {action ? <div className="mt-2 shrink-0 sm:mt-0">{action}</div> : null}
      </header>
      {children}
    </div>
  </div>
</div>
```

Rules:

- **Header:** title + description left; primary action right. Stacks on mobile (`flex-col sm:flex-row`). Content always **below** the header.
- **Container:** `mx-auto w-full max-w-2xl`.
- **Section padding:** `py-10 pb-20 lg:py-20`; `space-y-5` between header and body.
- **Major blocks inside body:** `space-y-4` (search + list), `space-y-6` (tab panels), `space-y-8` (settings sections).
- Mobile-first: test narrow width.

### Page header: one row for every project page

Every standalone project page (Spaces, Goals, a goal, Apps, Artifacts, an
artifact, Files, Calendar, Inbox, Memory) opens with `ProjectPageHeader`
(`@kortix/ui/workspace`). A page that must draw its own row uses
`PROJECT_PAGE_HEADER_CLASS`. Never write header numbers by hand.

1. **Geometry.** 44px tall (`h-12`), 11px gutters (`px-3`), a bottom border.
   The sidebar toggle, then the title, then the actions at the trailing edge,
   8px apart (`gap-2`).
2. **Title.** The page's `<h1>`, `text-sm font-medium`, on the toggle's line.
   A child page puts its parent first as a breadcrumb: `Goals › <goal>`.
3. **Actions, in this order:** search, sort, view controls, then the primary
   action. Sort is `SortMenu` (`@kortix/ui/sort-menu`). Search depends on the
   page: a page with a filter row under the header (Goals' All / Assigned to
   me, Artifacts' scope tabs) puts a plain `InputGroupSearch` (`sm:w-64`) at
   the end of that row, never in the header. A page with no filter row
   (Spaces, Apps) puts `ExpandableSearch` (`size="sm"`,
   `buttonVariant="outline"`) in the header, before sort.
4. **Sizes.** Every action is 29px tall: `size="sm"` for a labelled button,
   `size="icon-base"` for an icon button. No `xs`, no `icon-sm` in a page
   header. An icon is `size-4` in an icon button and `size-3.5` beside a
   label.
5. **Variants.** The page's primary action ("New space", "New goal",
   "New doc") is the default variant, last, with `PlusIcon`. Item actions on
   a child page ("Pause goal", "Share", ⋯) are `secondary`. Search, sort and
   view controls are `outline`.
6. **Spacing between actions.** The header's actions are separate buttons
   8px apart, not one `ButtonGroup`. The only group in a header is a
   segmented choice of one value (Apps' grid density): `ButtonGroup` of
   `outline` `icon-base` buttons with `aria-pressed`; the chosen one adds
   `bg-secondary text-foreground`, the others are `text-muted-foreground`.
7. **Sort.** `SortMenu` offers the page's orders as radio rows (Last
   activity, Name, Date created). `useStoredSort(key, orders, fallback)`
   keeps the choice per page in this browser; the first render uses the
   fallback, so server HTML matches. Grouped lists keep the order inside
   each group.
8. **What shows when.** Search and sort appear only once the page has items
   to search. The primary action shows in every state, the empty state
   included, unless the empty state itself is the starter (Goals).

Reference: `packages/ui/src/workspace/session-spaces/spaces-page.tsx`,
`apps/web/src/features/workspace/goals/goals-page.tsx`,
`apps/web/src/features/apps/apps-view.tsx`.

### List page rows: one line, fixed trailing columns

A list page (Spaces) shows items as rows, not cards, when a row's facts fit
on one line.

1. **Groups.** A hairline, collapsible header per group: `h-8`,
   `border-b border-border`, `px-3`, `text-xs font-medium
   text-muted-foreground`, a leading `CaretDownIcon` (`size-3`) that turns
   `-90deg` when closed, the group's name and its count (`tabular-nums`, meta
   ink). Never a filled `bg-muted` bar. A group with no rows is not drawn.
   The full recipe is "Recipe: list rows with groups" above.
2. **Row.** `h-11`, `px-3`, `border-b border-border`, `hover:bg-hover`, the
   whole row one link. Leading: the item's bare glyph (`size-4`, no tile) in
   the `w-5` leading slot, then the name (`text-sm`, `truncate`).
3. **Trailing columns.** Fixed widths, so every row lines up: people
   (`SessionParticipantStack`, the session header's avatar stack, never
   hand-drawn faces), access (`w-24`, a `size-3.5` icon and a word), time
   (`w-28`, `text-right`, `tabular-nums`, `whitespace-nowrap`), then the ⋯
   slot (`w-7`). A column that runs out of room truncates; it never pushes
   into the next one.
4. **Row menu.** The ⋯ button is a sibling of the link, never inside it.
   `ghost`, `icon-xs`, hidden until the row is hovered or focused
   (`opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100`),
   always shown on touch (`pointer-coarse:opacity-100`) and while its menu is
   open (`data-[state=open]:opacity-100`). Only a viewer who may manage the
   item gets one; the slot stays to keep the columns aligned.
5. **Small screens.** People and access hide below `sm`; name, time and ⋯
   stay.

## Card & panel patterns (no SectionCard)

A panel inside another panel, a form panel in a settings section and a floating panel are `bg-popover rounded-md border` surfaces. A bordered list that sits directly on a page is `bg-background` plus `border-border`: the color rule wins over this recipe ([`color.md`](../kortix-brand/references/visual/color.md), in-flow section, Q11). Two sanctioned ways to build a panel — never `SectionCard`:

- **`Card`** (`packages/ui/src/primitives/card.tsx`) — the codified panel. Use it when the surface has a title/description/action header, distinct content, or a footer. Slots carry the spacing (`px-4`, `pt-5`/`pb-5`, `gap-5` between slots — the panel `px-4 py-5` rhythm); the bordered element itself has **no padding**, so flush children (tables, lists, images) sit edge-to-edge.
- **Hand-composed `div`** — for a one-off padded block inside a section, the one-div shorthand `bg-popover rounded-md border px-4 py-5` is fine (the `project-settings-page.tsx` pattern). The moment the panel needs a flush child or an internal seam, move the padding onto inner sections.

Panels are **flat**: border, no shadow — elevation is for overlays (see _Elevation_ under Tokens).

### Card (component)

```tsx
<Card>
  <CardHeader>
    <CardTitle>Repository</CardTitle>
    <CardDescription>Where builds are pushed.</CardDescription>
    <CardAction>
      <Button size="sm" variant="secondary">
        Edit
      </Button>
    </CardAction>
  </CardHeader>
  <CardContent>
    {/* fields, rows — or a flush table as a direct Card child */}
  </CardContent>
  <CardFooter className="border-t">{/* meta or trailing actions */}</CardFooter>
</Card>
```

- `CardTitle` is `text-sm font-medium` — panel-label scale, same as `Label`. Don't scale it up; a Card is a panel, not a hero.
- Divided header: `<CardHeader className="border-b">` (it compacts to `pb-4`); divided footer: `className="border-t"`.
- `variant="glass"` (`bg-card/40 border-border/40 shadow-sm`) is the only elevated variant — translucent surfaces over wallpaper/media.

### Settings / form panel (inside a Modal or a legacy customize view)

On a settings page, use "Recipe: a settings form" above: label-left rows
separated by hairlines, no panel. This panel is for a group of fields inside
a `Modal` or in a legacy `customize/sections/view/*` screen.

```tsx
<section className="space-y-4">
  <Label>Repository</Label>
  <div className="bg-popover space-y-5 rounded-md border px-4 py-5">
    <FieldGroup className="grid gap-3 sm:grid-cols-2">
      {/* fields */}
    </FieldGroup>
  </div>
</section>
```

### Composition: one grid per surface

Tokens and primitives do not make a surface look finished. A surface looks
cheap when every part is correct alone and the parts do not agree with each
other. Before you ship a modal, a popover, a sheet or a settings panel, check
these six rules. Each one is a number you can measure.

1. **One inset.** Choose one horizontal inset for the surface (`px-3` in a
   modal, `px-4` in a page panel). Every row, field and group uses it. The
   text of every row starts on the same vertical line.
2. **One control height.** A field and the button beside it have the same
   height (`Input size="md"` with `Button size="lg"`, or `sm` with the
   default). A copy field, a search field and an add field in one surface
   are the same height.
3. **One leading slot.** Every row in a surface has the same leading box
   (`size-8` avatar or `size-8` icon tile). Never a `size-9` tile under a
   `size-8` avatar: the titles then start 4px apart.
4. **One row height.** Rows in one group have one height. Give the row a
   `min-h-*` that fits the two-line case, so a one-line row and a two-line
   row are equal. Name over meta uses `leading-tight` on both lines.
5. **One trailing edge.** The last glyph of every trailing slot ends on the
   same vertical line: a role word, a `Role ▾` button, a caret. A text
   button there takes a negative end margin equal to its padding
   (`-mr-2.5` for `size="sm"`), so its label ends on the edge, not its
   padding. A control that changes a row sits in the trailing slot, never
   in the title position.
6. **An inset button fills its field.** A button inside a field sits one
   inset from the top, the bottom and the end (`p-1`, `h-full`) and keeps
   the `Button`'s default radius: never a one-off radius. Never a small
   button floating in a tall field.

### Grouped rows: one container, not a card per row

Rows of the same kind that belong to one question ("who has access", "which
keys") are **one bordered container with a hairline between rows**:

```tsx
<section className="space-y-2">
  <h3 className="text-muted-foreground text-xs font-medium">People with access</h3>
  <ul className="divide-border border-border divide-y rounded-md border">
    <li className="flex min-h-14 items-center gap-3 px-3 py-2">
      {/* leading: size-8 avatar or tile */}
      {/* body: min-w-0 flex-1, name over meta, leading-tight */}
      {/* trailing: role word, or Button variant="ghost" size="sm" className="-mr-2.5" */}
    </li>
  </ul>
</section>
```

- The container has no fill: it sits on the surface it is in. A filled card
  per row puts N outlines and N gaps where one outline reads as one list.
- A group with one row (a single setting, such as general access) is the
  same container and the same row. It is not a different component.
- Sections are `space-y-5` apart; a label is `space-y-2` above its group.
- Inside a `Modal`, a popover or a sheet, always use the group.

Use the separate **entity row** below only for a page-level list where each
row is its own object with its own actions, state and navigation (agents,
connectors, secrets). Never mix the two in one surface.

**Reference:** `packages/ui/src/workspace/session-spaces/space-share-modal.tsx`
(`GROUP`, `ROW`, `TRAILING_BUTTON`, and the copy-link field).

### Entity row (legacy customize views only)

New list pages and detail-page lists use "Recipe: list rows with groups"
above: hairline rows, no card per row. This card-per-row recipe exists in
older customize views; do not copy it into new work.

```tsx
<ul className="space-y-2">
  <li className="group bg-popover flex items-center gap-3 rounded-md border px-4 py-2 transition-colors">
    {/* leading: size-9 tinted icon tile */}
    {/* body: min-w-0 flex-1 */}
    {/* trailing: Button size="sm" */}
  </li>
</ul>
```

Access rows use `py-2.5` (`packages/ui/src/access/access/access-row.tsx`). Changes use `py-2`.

### Config entity disclosure (agents, skills, commands)

```tsx
<div className="space-y-2">
  <Disclosure
    variant="outline"
    className="overflow-hidden"
    open={open}
    onOpenChange={setOpen}
  >
    <DisclosureTrigger variant="outline">
      <Button
        variant="popover"
        className="flex w-full items-center justify-start rounded-none"
      >
        <span className="truncate text-sm font-medium">{name}</span>
      </Button>
    </DisclosureTrigger>
    <DisclosureContent
      variant="outline"
      contentClassName="border-border border-t"
    >
      <div className="relative px-4 py-5">{/* detail */}</div>
    </DisclosureContent>
  </Disclosure>
</div>
```

Detail header: `text-2xl font-semibold tracking-tight` title; meta `Badge variant="outline" size="sm"`; toolbar `absolute top-4 right-4` with `ButtonGroup` + `Hint`.

### Dropdown item with icon + title + description

One recipe for every menu row that carries a glyph, a title and a one-line
explanation (the "New ▾" menu on Agents, Skills, Connectors, Triggers and
Secrets). Source: `RichRowBody` in
`packages/ui/src/customize/shared/new-entity-menu.tsx`;
Paper "New menu · icon + title + description", V03 (Jay, 2026-10-13).

```tsx
<DropdownMenuContent align="end" className="w-76">
  {" "}
  {/* 280px */}
  <DropdownMenuItem className="items-start gap-2.5 py-1.5">
    {" "}
    {/* px-2 rounded-sm from menuRow */}
    <ChatCircleIcon className="text-muted-foreground mt-0.5 size-4 shrink-0" />
    <span className="flex min-w-0 flex-1 flex-col">
      <span className="text-foreground text-sm font-[550]">Create in chat</span>
      <span className="text-muted-foreground mt-0.5 text-xs font-normal text-pretty">
        An agent scaffolds it and opens a change request.
      </span>
    </span>
  </DropdownMenuItem>
</DropdownMenuContent>
```

- **First-line alignment, after `alert.tsx`.** `items-start` plus `mt-0.5` on the
  16px glyph centres it on the title's first 20px line. Never `items-center`
  (the glyph drifts to the middle of a two-line block) and never a bare
  `items-start` (the glyph sits on the cap height).
- **Two tiers.** Title `text-sm font-[550] text-foreground`, ink even before
  hover; the row's own `text-foreground/80` and `font-medium` would make it read
  lighter than the description's job. Description `text-xs text-muted-foreground
font-normal`, `mt-0.5` under the title.
- **Width.** `w-76` (280px) lets a one-sentence description wrap at most once.
  `w-64` wrapped after about 30 characters.
- **Glyph.** Muted, `size-4`, no tile. Use the row's leading glyph, never a
  second one at the end.

### Danger zone (settings)

A row of the settings form, not a panel. No red fill, no red border, no
solid red button on the page:

```tsx
<div className={FIELD_ROW}>
  <span className="text-muted-foreground text-sm">Archive trigger</span>
  <Button variant="outline" size="lg" className="text-destructive justify-self-end" onClick={openConfirm}>
    Archive…
  </Button>
</div>
```

The consequence ("It stops firing. Its runs stay readable.") goes in the
`ConfirmDialog` this button opens. The solid `variant="destructive"` button
appears only inside that dialog.

## Floating action bar — `ActionBar`

**A temporary mode puts its actions in one floating bar at the bottom centre of
the page column.** The modes: a multi-selection ("3 selected"), unsaved edits
("Unsaved changes."), a pending clipboard ("Moving 2 items"). Never in the
toolbar, the section heading or the table header: that moves the controls away
from the rows and shifts the layout when the mode starts.

```
[leading] Title  muted description        [ Action | Save ⌘S | Delete ]  [×]
```

- **Component:** `ActionBar` and `ActionBarDock` (`packages/ui/src/primitives/action-bar.tsx`,
  import `@kortix/ui/action-bar`; live demo `/design-system#comp-action-bar`).
  Never hand-build a `bg-popover rounded-lg border shadow-md` bar. If a mode
  needs something the bar lacks, add a prop to `ActionBar`.
- **Props:** `title` (the mode in a few words, announced with `aria-live`),
  `description` (one muted fact), `leading` (a glyph, such as the clipboard),
  `actions`, `close` (`{ label, onSelect }`: the trailing × that leaves the
  mode), `busy` (the dot matrix leads, every control disables), `animateIn`.
- **Each action:** `label` (a word, no glyph), `tone: 'destructive'` for a
  removing verb, `tone: 'success'` for an approving verb, `emphasis: 'primary'`
  for at most one commit verb, `kbd` for its key hint (`'⌘S'`), `loading`,
  `disabled`. `kbd` only draws the key and sets `aria-keyshortcuts`: the page
  binds the key (`agent-page.tsx`, `routing-parts.tsx` bind ⌘S).
- **Placement:** wrap it in `ActionBarDock` inside the non-scrolling, positioned
  column (`absolute inset-x-0 bottom-4`, centred, `max-w-xl`). Not plain `sticky`
  inside a scroller: `sticky` stops under a short list. When the page scrolls
  the window, use a `fixed` frame over the column (`RoutingSaveBar`).
  In the account hub: `AccountHubSelectionBar` (`packages/ui/src/internal/account-hub/hub-sheet.tsx`).
- **Narrow:** under 32rem of its own width the actions drop to a full-width
  second row. Do not hide labels behind icons.

### Bulk selection

- **Component:** `SelectionBar` (`packages/ui/src/internal/selection/selection-bar.tsx`),
  the `ActionBar` for select mode: the "N selected" title, Select all first,
  then the caller's actions, then the exit ×.
- **Selection:** a checkbox gutter on each row and a select-all checkbox in the
  table head (`MemberTableHead` / `MemberTableRow`). The bar renders only while
  select mode is on, and the exit × clears the selection.
- **Running:** pass `progress` for a long batch, or disable the actions. Run the
  calls with `Promise.allSettled`, refresh the list once, and show one toast for
  the batch.

References: `schedule/trigger-selection-bar.tsx` (Triggers), `drive-selection-bar.tsx`
and the clipboard bar in `drive-explorer.tsx` (Files), `RoutingSaveBar` in
`gateway/routing-parts.tsx` (Models routing), `SaveBar` in
`agents/agent-page-chrome.tsx` (Agents), `access-projects-tab.tsx` (join requests).

## Button conventions

Match the customize views — consistent sizes and variants:

| Context                       | Pattern                                                                                                                                       |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Section header primary action | `Button size="sm" variant="secondary"` + `PlusIcon` (`size-4`) + label; group with `gap-1.5`                                                  |
| Empty state CTA               | `Button variant="outline" size="sm" className="gap-1.5"`                                                                                      |
| Docs / secondary link         | `Button asChild variant="ghost" size="sm" className="gap-1.5"`                                                                                |
| Row secondary action          | `Button variant="ghost" size="sm"`                                                                                                            |
| Row primary action            | `Button size="sm"` (default variant)                                                                                                          |
| Icon-only with tooltip        | `Hint` → `Button variant="outline" size="icon"` inside `ButtonGroup`                                                                          |
| Inline text link              | `Button variant="transparent" size="sm" asChild`                                                                                              |
| Modal cancel                  | `Button variant="outline-ghost"`                                                                                                              |
| Pending / in-flight state     | `<Loading className="size-4 shrink-0" />` in buttons; `<Loading />` or `className="size-4 shrink-0"` in headers — **never** `CircleNotchIcon` |

Icons in buttons: `size-3.5 shrink-0` (dense) or `size-4` (header). Always `shrink-0` on icons. **Exception:** loading uses `Loading`, not an icon import.

### Button groups — the default for buttons in a row

**Two or more buttons side by side that serve one surface are a `ButtonGroup`** (`@kortix/ui/button-group`). A toolbar cluster, a back/forward pair and a viewer's close cluster are all groups. **Exception:** a project page header's actions are separate buttons 8px apart (see Page header, rule 6). Do not line buttons up with `flex gap-1` and hand-tuned `ml-*`: the group owns the spacing (`gap-px`) and joins the corners of neighbours, so a row of controls reads as one object instead of loose icons.

| Rule                                                                                                                                                 | Why                                                                                                                                                           |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One variant for every member: all `ghost`, all `secondary` or all `outline`.                                                                         | Mixed weights break the group into a primary plus strays. A real primary action stands outside the group.                                                     |
| The close `X` joins the group of the actions beside it.                                                                                              | It is part of the toolbar, not a separate control.                                                                                                            |
| Every member is a direct child: `Hint` (it renders `asChild`) wrapping a `Button` is fine, and so are `asChild` links.                               | The corner rounding targets direct children (`[&>*]`). A `<span>` or a `PopoverAnchor` wrapper between the group and the `Button` takes the rounding instead. |
| No dividers, `gap-*`, `ml-*` or `mx-*` inside a group.                                                                                               | The group sets the rhythm; one override drifts every row.                                                                                                     |
| One group per job. Navigation (back/forward) and page actions (open, full screen, close) are two groups, with the address bar or title between them. | A group says "these act on the same thing".                                                                                                                   |
| A hidden member (`{cond && …}`) is fine; a group of one is not: render the lone `Button` bare.                                                       | A group of one adds nothing.                                                                                                                                  |

**Not a group:** a modal or form footer (Cancel + Confirm stay a spaced pair, so the destructive or primary choice is not glued to Cancel), and a button beside a text input that is not part of it. Icon buttons inside an address or path pill are a group too: the pill holds the group at its trailing edge.

Reference implementations:

| File                                                                 | Group                                                                                         |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `app/[locale]/(public)/share/session/[token]/page.tsx`               | Header actions, all `secondary`: open app, full screen, download or copy link, Open in Kortix |
| `packages/ui/src/browser/sandbox-browser-chrome.tsx`                 | Back / forward, `ghost`; Reload and the pill's trailing actions inside the address pill       |
| `packages/ui/src/files/viewer/viewer-actions.tsx` (`ViewerPathPill`) | Refresh, copy, copy link inside the path pill, `ghost`                                        |
| `packages/ui/src/session/panel/easy/app-preview.tsx`                 | Open in new tab, full screen, close, `ghost`                                                  |
| `packages/ui/src/files/viewer/file-viewer.tsx`, `file-preview.tsx`   | Save as PDF or Present, Download, full screen, close, `ghost`                                 |
| `packages/ui/src/changes/change-list.tsx`                            | Unified / split diff toggle, `outline`                                                        |

## Cursor affordance

**Every clickable element shows `cursor: pointer`.** Disabled elements keep
`cursor: default`. Do not add `cursor-default` to an interactive element.

- A clickable element is a `<button>`, a `<Link>`, or has a `role`. Never put
  `onClick` on a bare `div`.
- The base rule in `apps/web/src/app/globals.css` gives the pointer to buttons,
  links, `label[for]`, native checkbox/radio/file inputs, selects, summaries,
  and the `button` / `checkbox` / `link` / `menuitem` / `menuitemcheckbox` /
  `menuitemradio` / `option` / `radio` / `switch` / `tab` / `treeitem` roles.
  It excludes `:disabled`, `aria-disabled`, and `data-disabled`.
- A utility class beats `@layer base`, so a stray `cursor-default` silently
  removes the pointer. `tests/unit/cursor-affordance.test.ts` fails on a
  `cursor-default` in `packages/ui/src/primitives` without an inline reason.

## Icons — Phosphor, plus the house glyph set

**The only icon library in apps/web is `@phosphor-icons/react`.** `lucide-react`,
`react-icons`, `@mynaui/icons-react`, and `@icons-pack/react-simple-icons` are
removed and blocked by ESLint (`no-restricted-imports`).

- **House glyphs (D4i).** `packages/ui/src/internal/icons` (the glyphs the package renders) and `apps/web/src/features/icon/icons` (the ones only apps/web renders) hold the glyphs Phosphor lacks and the third-party marks. A house glyph uses `currentColor` and takes its size from `className`. When you add one, replace every Phosphor equivalent in the same change.
- Always import the `*Icon`-suffixed exports: `PlusIcon`, `MagnifyingGlassIcon`,
  `CaretRightIcon` — never the deprecated bare names (`Plus`).
- **Never pass a `weight` prop.** One constant governs the whole app:
  `DEFAULT_ICON_WEIGHT` in `packages/ui/src/lib/icon-config.ts` (currently `bold`).
  Change it, save, and every icon flips; commit it and production renders the
  same. There is no runtime toggle and **no dev/prod branching** — the constant
  is the single source of truth in every environment. Compare all six weights
  at /design-system → Icons.
- **Two delivery paths, same constant, both propless:**
  - _Client components_ → `IconProvider` (root layout) feeds it to Phosphor's
    `IconContext`. Import from `@phosphor-icons/react`.
  - _Server components (RSC)_ → React context does not exist in RSC, so import
    from **`@/lib/icons/ssr`**, where the weight is pre-bound. Importing
    `@phosphor-icons/react/dist/ssr` directly is ESLint-blocked (it silently
    defaults to `regular`); importing the main entry in a server component
    crashes the build (`createContext` at module scope). Adding an icon to a
    server component? Add its two lines to `src/lib/icons/ssr.tsx`.
- **Exception — solid intent:** status tiles, destructive
  trash, and logo glyphs pass an explicit `weight="fill"` so they stay solid
  regardless of the global weight. Completion checks use `SolidCheckIcon`, not a Phosphor weight variant.
- Semantic layer: `packages/ui/src/primitives/kortix-icons.ts` (`IconAdd`, `IconDelete`,
  …) re-exports Phosphor icons; prefer it where already adopted. It re-exports
  the client entry, so it is client-graph only.
- Sizing stays Tailwind-first (`size-4`, `size-3.5 shrink-0` in dense buttons);
  the provider's `size: 24` default only covers class-less usages.
- Background on the RSC rule above: the main entry calls `createContext` at
  module scope with no `'use client'` directive, so a server-only module graph
  reaching it crashes the build with
  `TypeError: (0, d.createContext) is not a function`. Phosphor's own SSR entry
  fixes the crash but hardcodes `weight="regular"`, which would quietly ignore
  `DEFAULT_ICON_WEIGHT` — that is why `@/lib/icons/ssr` exists and why the raw
  entry is ESLint-blocked outside it.

**apps/mobile uses Phosphor too** (`phosphor-react-native`, the community React
Native port with the same 1,512 glyphs and names). Its rules differ from web in
two places, both caused by Metro:

- Import icons only from `@/lib/icons`. That registry is the only file that
  imports the package, one icon file at a time: Metro tree shaking is off, so
  the package barrel would ship every icon in all six weights.
- The registry binds `DEFAULT_ICON_WEIGHT` (`apps/mobile/lib/icons/icon-config.ts`,
  `bold`) onto each icon, because `IconContext` is exported only from that
  barrel. `weight="fill"` is still the only weight prop.
- `apps/mobile/lib/icons/icon-imports.test.ts` fails on a retired icon library,
  a direct package import, an unused registry entry, a non-`fill` weight, or a
  spinner glyph.

## Motion in components

**Budget and easings live in [`kortix-brand` → `motion.md`](../kortix-brand/references/visual/motion.md).**
Read the frequency ladder there before adding any animation. The short version:

> Kortix is a speed product. **Fast, or none.** Count how many times a day a user
> sees the interaction; that number sets the budget. Constant-use surfaces —
> keyboard nav, dense-list hover, focus moves, table selection — get
> **no animation at all**.

What that means for the components in this file:

| Component                                 | Motion                                                                                                                 |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Row hover in a list, sidebar nav          | `transition-colors duration-fast`. Color only — never position.                                                        |
| Keyboard-driven selection / arrow-key nav | **None.** `transition-none`.                                                                                           |
| `Disclosure`, `Tabs`                      | 200ms, `ease-out`. Built in — do not add more.                                                                         |
| `Modal`, `Dialog`, sheets                 | 300ms max, `ease-out`, enter from `scale-0.97`. Built into `modal.tsx`.                                                |
| Toast                                     | Owned by `toast.tsx`. Do not restyle its motion.                                                                       |
| `Loading`                                 | Ships its own rotation. Never add `animate-spin`.                                                                      |
| Buttons                                   | `active:scale-[0.96]` + `transition-colors`. Nothing else. A full-width row presses with `active:scale-[0.998]` (D4k). |
| Skeleton → content                        | Cross-fade opacity, or nothing. Never a stagger.                                                                       |

**Do not add enter animations to list items.** A staggered or animated list is
measurably slower to read and to click than the same list appearing at once, and
the cost is paid on every render.

### Sanctioned exception — the icon-swap morph

**Frequency gate:** this pattern is for buttons whose state change is _meaningful
and occasional_ — copy → copied, connect → connected, follow → following. It is
**not** for a control the user hits repeatedly in a working session. If in doubt,
hard-swap the icon; a hard swap is never wrong, it is only plain.

When it does apply: never hard-swap `{done ? <CheckIcon/> : <CopyIcon/>}` with no
transition. Cross-fade the two icons in the same box with **blur + scale +
opacity** so it reads as one morph, not two objects blinking. The blur is what
bridges the two states — without it the eye sees two distinct objects.

Values: **scale `0.25 → 1`, opacity `0 → 1`, blur `4px → 0`**, spring
**`{ type: 'spring', duration: 0.3, bounce: 0 }`**. `bounce: 0` is the brand.
Always `initial={false}` so nothing animates on first paint.

```tsx
import { AnimatePresence, motion } from "motion/react";

<button
  onClick={handleCopy}
  aria-label={copied ? "Copied" : "Copy"}
  className={cn(
    "inline-flex size-7 items-center justify-center rounded-md",
    "text-muted-foreground hover:text-foreground hover:bg-muted-foreground/10",
    "cursor-pointer transition-colors active:scale-[0.96]",
  )}
>
  <span className="relative inline-flex size-3.5 items-center justify-center">
    <AnimatePresence initial={false} mode="popLayout">
      <motion.span
        key={copied ? "check" : "copy"}
        initial={{ scale: 0.25, opacity: 0, filter: "blur(4px)" }}
        animate={{ scale: 1, opacity: 1, filter: "blur(0px)" }}
        exit={{ scale: 0.25, opacity: 0, filter: "blur(4px)" }}
        transition={{ type: "spring", duration: 0.3, bounce: 0 }}
        className="absolute inset-0 inline-flex items-center justify-center"
      >
        {copied ? (
          <CheckIcon className="size-3.5 text-kortix-green" />
        ) : (
          <CopyIcon className="size-3.5" />
        )}
      </motion.span>
    </AnimatePresence>
  </span>
</button>;
```

Rules: both icons share one fixed-size box (`relative size-3.5` parent, each
child `absolute inset-0`) so they overlap and the blur bridges the crossfade.
Confirmed status colour stays a `kortix-*` token (`text-kortix-green`), never raw
palette. Ship a `prefers-reduced-motion` branch — drop the scale and blur, keep
the opacity. **Reference:** `CopyButton` in
`packages/ui/src/markdown/copy-button.tsx`.

## Spacing cheat sheet (from reference views)

| Layer                      | Classes                                                                   |
| -------------------------- | ------------------------------------------------------------------------- |
| Section wrapper → body     | `space-y-5`                                                               |
| Search + content block     | `space-y-4`                                                               |
| List of rows / disclosures | `space-y-2` inside `space-y-4` parent                                     |
| Settings major sections    | `space-y-8`                                                               |
| Tab panel content          | `space-y-6`                                                               |
| Panel inner padding        | `px-4 py-5` (standard), `px-4 py-3` (compact row)                         |
| Row internal gap           | `gap-3` (row), `gap-1.5` (title/meta), `gap-2` (button groups)            |
| Detail content below title | `mt-8`                                                                    |
| No-match empty search      | `px-3 py-6 text-center text-xs`                                           |
| `Card` slot rhythm         | `px-4` all slots; `pt-5` header / `pb-5` last slot; `gap-5` between slots |

**Padding never sits on a bordered element that hosts flush children** (tables, lists, seams) — put it on the slots/inner sections. A single padded block may use the one-div shorthand `bg-popover rounded-md border px-4 py-5`.

## Tokens — see `kortix-brand`

**Every value lives in [`kortix-brand`](../kortix-brand/SKILL.md)** (`references/visual/visual-system.json`, explained by the visual guidance files).
Colors, spacing steps, type rungs, radius ladder, elevation steps, easings and
durations are enumerated there as closed allowlists, with the reasons and the
`audit.sh` that enforces them. This file used to restate them; two copies drift,
so the copy is gone.

The five facts you will get wrong from stock Tailwind habit, restated here only
because they bite immediately:

| Fact                                                    | Consequence                                                                            |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `--spacing: 0.23rem`, not `0.25rem`                     | Every spacing utility is 8% tighter. A 16px mockup padding is `p-4`, never `p-[16px]`. |
| `--text-xs: 0.8125rem` = **13px**, not 12px             | `text-xs` is the workhorse (1999 uses). There is no rung below it.                     |
| `--radius: 0.625rem` → `rounded-md` is **8px**          | `rounded-md` is the default for every panel, row, table and card.                      |
| Color is semantic tokens + the seven `kortix-*` accents | No raw palette, no hex, and **no `dark:` for color** — tokens flip themselves.         |
| In-flow surfaces are **flat** — border, no shadow       | Shadows mean "floats above the page".                                                  |

## Status pattern — tinted icon tile (one standalone verdict only)

Use a tinted tile only for the one status verdict a surface is about (a
review's result, a provider's coverage). **Never in a list row, a feed or a
menu:** a row's state is a bare `size-4` glyph in `STATUS_TEXT`, and a neutral
event is a meta-ink glyph with no tile.

```tsx
<span className={cn(
  'flex size-9 items-center justify-center rounded-sm',
  merged && 'bg-kortix-green/15',
  failed && 'bg-kortix-red/15',
  open && 'bg-kortix-blue/15',
)}>
  <Icon className={cn('size-5', merged && 'text-kortix-green', …)} />
</span>
```

Use `weight="fill"` icons at `size-5` inside `size-8`/`size-9` tiles. Pair with `Badge` for text labels when needed (`review-detail.tsx`, `sandbox-provider-coverage.tsx`).

## Modal pattern (canonical — use `modal.tsx`)

From `secrets-view.tsx` / `channels-view.tsx` — **not** raw Dialog:

```tsx
<Modal open={open} onOpenChange={setOpen}>
  <ModalContent className="lg:max-w-lg">
    <ModalHeader>
      <ModalTitle>Title</ModalTitle>
      <ModalDescription>Description</ModalDescription>
    </ModalHeader>
    <form onSubmit={handleSubmit}>
      <ModalBody className="max-h-[60vh] overflow-y-auto">
        {/* fields */}
      </ModalBody>
      <ModalFooter className="sm:justify-between">
        <Button
          type="button"
          variant="outline-ghost"
          onClick={() => setOpen(false)}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={pending}>
          {pending ? <Loading className="size-4 shrink-0" /> : null}
          Save
        </Button>
      </ModalFooter>
    </form>
  </ModalContent>
</Modal>
```

Destructive confirms → `ConfirmDialog`, not a red-styled `Modal` trigger.

## Tabs pattern

- **Default `TabsList`:** the segmented control (recessed track, raised `shadow-xs` chip). A vertical list (a settings rail) is never segmented (`packages/ui/src/primitives/tabs.tsx`).
- **Primary section tabs:** `TabsList type="underline"` + `TabsTrigger className="w-fit flex-none"` (`channels-view.tsx`)
- **Filter / status tabs:** `TabsList size="xs"` + `TabsTrigger` (`project-sessions-view.tsx`, `secrets-view.tsx`)
- Tab badge count: `<CountBadge count={n} />` inside trigger

## Loading pattern (canonical)

**Every in-flight spinner is `Loading` from `loading.tsx`. There are no exceptions and no second spinner in this codebase.** The component ships its own rotate/dash animation, so it never needs `animate-spin`.

**No icon is ever a spinner.** Not `CircleNotchIcon`, not `SpinnerIcon`, not `SpinnerGapIcon`, not any other Phosphor glyph, whatever it is aliased to (`Loader`, `Loader2`, `IconLoader`, …). If you catch yourself writing `animate-spin` on an icon, the answer is `Loading`. `kortix-icons.ts` deliberately exports **no** loader icon so the semantic layer can't offer you one.

```tsx
import Loading from '@kortix/ui/loading';

// Button pending (replaces action icon)
<Button disabled={pending}>
  {pending ? <Loading className="size-3.5 shrink-0" /> : <PlusIcon className="size-3.5 shrink-0" />}
  Save
</Button>

// Section header action
<Button size="sm" variant="secondary" disabled={pending}>
  {pending ? <Loading className="size-4 shrink-0" /> : <PlusIcon className="size-4" />}
  New
</Button>

// Inline / modal submit
{pending ? <Loading className="size-4 shrink-0" /> : null}
```

Page-level loading is **`ProjectPendingScreen`** (the pulsing Kortix mark), not a skeleton (D4h). Use **`Skeleton`** only for a local element whose final shape is known (a field, a logo tile). Use **`Loading`** for active async operations (submit, fetch-in-button, mutation pending). For session-scoped work, such as an approve or deny button while a decision saves, use `SessionDotMatrix` (D4f). Never flash a fallback that the real content then replaces.

## Search + loading + empty flow

Standard content block (`agents-page.tsx` pattern):

```tsx
<div className="space-y-4">
  <InputGroupSearch>…<InputGroupSearchInput />…</InputGroupSearch>
  {isLoading ? (
    <div className="space-y-1">{/* Skeleton h-7 rounded-md × 5 */}</div>
  ) : isError ? (
    <ErrorState size="sm" action={<Button variant="outline" size="sm">Retry</Button>} />
  ) : items.length === 0 ? (
    <EmptyState size="sm" action={…} />
  ) : (
  /* list */
  )}
</div>
```

## Dos & Don'ts

- ✅ Page shell → `CapabilityPageShell` for a new page (`CustomizeSectionWrapper` only under `packages/ui/src/customize/sections/view/`). ❌ hand-rolled outer flex + header, ❌ `[&_header_h2]:` overrides of the shell header.
- ✅ Panels → `Card` (`card.tsx`) or `bg-popover rounded-md border` with `px-4 py-5`. ❌ `SectionCard`, ❌ padding on a bordered element that hosts flush children.
- ✅ Elevation → ladder step (`shadow-md` popovers, `shadow-lg` modals); in-flow panels stay flat with a border. ❌ `dark:shadow-*`, ❌ `shadow-[…]` when a step fits.
- ✅ Lists → hairline rows, "Recipe: list rows with groups". ❌ `List` / `ListRow`, ❌ a card per row, ❌ a filled group header bar.
- ✅ Expandable config → `Disclosure` + `Button variant="popover"`. ❌ custom accordion, ❌ nested rounding unless concentric (inner radius = outer radius minus inset; otherwise the child is flush). See [effects.md](../kortix-brand/references/visual/effects.md).
- ✅ Modals → `Modal` from `modal.tsx`. ❌ `Dialog`/`DialogContent` in features.
- ✅ Destructive actions → `ConfirmDialog` (or the inline two-step Cancel/confirm swap, `channels-view.tsx`). ❌ firing a delete/revoke mutation directly from a `variant="destructive"` click.
- ✅ Tooltips → `Hint`. ❌ `Tooltip` primitives in features.
- ✅ Two or more buttons in a row on one surface → `ButtonGroup`, one variant, close `X` included. ❌ `flex gap-1` rows of loose buttons, ❌ `ml-*` / dividers between members, ❌ a group of one, ❌ grouping a modal's Cancel + Confirm.
- ✅ Toasts → `@kortix/ui/toast` helpers. ❌ `@/lib/toast` (deleted), raw sonner, `toast.success()`.
- ✅ Badges → `<Badge size="sm" variant="…">`. ❌ hand-rolled chip spans.
- ✅ Status in a row → a bare `size-4` glyph in `STATUS_TEXT`; a resting state in meta ink. ❌ a tinted tile in a row or feed, ❌ raw palette icon colors, ❌ hue on a person, model or neutral event.
- ✅ Color → `kortix-*` + semantic tokens. ❌ `text-emerald-600`, `bg-amber-500`.
- ✅ Clickable elements → `cursor: pointer`; disabled keep `default`. ❌ `cursor-default` on an interactive element.
- ✅ Meta separators → `InlineMeta` or `text-muted-foreground/40` bullet (`&bull;`). ❌ inconsistent separators.
- ✅ Empty tab, folder or list → `EmptyState` + `EmptyArt` (one Phosphor glyph), one title, one sentence, outline buttons with icons (D14). ❌ centered `<p>` only, ❌ any other decorative tile or illustration, ❌ a forked or restyled `EmptyState` / `EmptyArt` (Q23).
- ✅ Alerts → `Alert`. ❌ hand-rolled colored banners.
- ✅ Pending spinners → `Loading` from `loading.tsx`. ❌ `CircleNotchIcon`, `SpinnerIcon`, or any `animate-spin` icon.
- ✅ Motion → count the frequency first; `transition-colors duration-fast` on hover, `ease-out` on enter/exit, `active:scale-[0.96]` on press. ❌ `transition-all`, ❌ bare `transition`, ❌ `ease-in`, ❌ anything over 300ms in product UI.
- ✅ Keyboard-driven interactions → `transition-none`. ❌ animating arrow-key nav or focus moves.
- ✅ Every animation ships a `prefers-reduced-motion` variant. ❌ one variant only.
- ✅ List items appear at once. ❌ stagger in product UI.
- ✅ Interactive elements show the pointer from the global rule. ❌ `cursor-default` on a clickable element.
- ✅ Same kind, same shape: a fixed label column and the thing beside it. ❌ a block that changes layout per item.
- ✅ One name, one info icon with a hover card. ❌ title over description over sub-title over sub-description; ❌ an intro paragraph that repeats the heading.
- ✅ A list draws loading, empty, error and loaded with `Skeleton`, `EmptyState`, `ErrorState` and rows. ❌ a spinner for a list, ❌ a page skeleton the route cannot draw.
- ✅ An action keeps its label through pending and done; the glyph swaps. ❌ an inline "Saved" line, ❌ a label that widens the button.
- ✅ Hover changes color only. ❌ a lift, a translate or a shadow on hover in app chrome.
- ✅ A glyph nudge on one primary or marketing link, `duration-fast`, reduced-motion branch. ❌ translate on a row, a menu item or a cell.

## Workflow checklist

1. **Load [`kortix-brand`](../kortix-brand/SKILL.md)** — the value allowlists and the motion budget. Then this file, then [`make-interfaces-feel-better`](../../../apps/web/.agents/skills/make-interfaces-feel-better/SKILL.md).
2. **Copy the recipe** for your page type from "The product look", then read the closest reference view from the table above. Copy structure, spacing, and primitives — don't invent a new layout dialect.
3. Open `/design-system` and skim [`references/component-index.md`](references/component-index.md) for anything not covered by the reference. Map every value through [`references/token-map.md`](references/token-map.md).
4. Structure: parallel slots, one name plus an info icon, the four states ([`references/patterns.md`](references/patterns.md)).
5. Compose: the frame for the page type ("Page width: by page type": `ProjectPageHeader` + full width for list and detail pages, `CapabilityPageShell` for settings) → search/panel/row/disclosure/table → `Badge` + `Hint` + `Modal` + `toast` + `Loading` + `EmptyState` + `EmptyArt`. Buttons in a row → `ButtonGroup`. **Never** `SectionCard`, `List`, or `CircleNotchIcon`.
6. Status → a bare glyph in `STATUS_TEXT`, hue only for live or attention states. Color → `kortix-*`. Radius → `rounded-md` (panel), `rounded-none` (flush trigger). Elevation → overlays only; flat border for in-flow panels.
7. **Motion last.** Count how often a user sees it. Constant → none. Otherwise ≤300ms, `ease-out`, named property, token duration, reduced-motion variant.
8. New primitive? Tokens only, tiny API, add to `/design-system`.
9. Verify: `.agents/skills/kortix-brand/scripts/audit.sh <your paths>` clean, no banned imports, nested rounding only when concentric (see [effects.md](../kortix-brand/references/visual/effects.md)), light + dark, `tsc` clean, polish checklist from `make-interfaces-feel-better`.
10. Replay the interaction ten times. If you still notice the animation, it is too much.

Tabs: use `<TabsList variant="secondary">` for transparent tabs with a `bg-secondary` active tab. Use `size="xs"` for small tabs. Compact tab components are removed.

## Copy and completion icons

- Every copy action uses `CopyButton` from `@kortix/ui/markdown/copy-button`: text, links, code, tokens, and IDs.
- It uses `Copy` from `@kortix/ui/icons` (`packages/ui/src/icons/copy.tsx`) and swaps in `SolidCheckIcon` from `@kortix/ui/internal/icons/solid-check-icon` after clipboard success. Keep one fixed icon box. Reduced motion swaps immediately.
- Within `packages/ui`, custom copy controls reuse `AnimatedCopyIcon` with those same two icons. Hosts compose `CopyButton`. Preserve clipboard error handling and an accessible label. Never use Phosphor CopyIcon or a local copy timer.
- Completion and success use `SolidCheckIcon`. Never use a square filled CheckIcon as a completion symbol. A checkbox is for an editable selection only.
- Avoid crowded cards. Use one heading, short facts, and one primary action. Put secondary explanation in an info hover card. Keep space between header, body, and actions. Do not stack a description under every fact.

Timestamp details use `Hint` from `@kortix/ui/hint`, never `HoverCard`. `InlineMetaTime` follows this rule. Reserve hover cards for richer previews such as related-item lists.
