# Record: a Google Sheet

`record.kind: google-sheet`, `record.target: <spreadsheet id>`. Choose it when
the team keeps its pipeline in a spreadsheet. The sheet is shared only with
the team and the connected Google account, never "anyone with the link":
setup checks the sharing once and asks the person to fix it.

## Access

The Google Sheets connector (`googlesheets` or the slug the workspace uses):
`kortix connectors show <slug>` once per session for the tool names (read
values, append rows, update a range), then
`kortix connectors call <slug> <tool> '<json>' --json`.

## Tabs and columns

Setup creates four tabs with a header row. The loop finds columns by header
name, never by position, so a person may add or reorder columns.

| Tab | Columns the loop reads and writes |
|---|---|
| `Companies` | `key`, `domain`, `name`, `website`, `score`, `tier`, `updated` |
| `People` | `key`, `email`, `name`, `title`, `opt_out`, `updated` |
| `Deals` | `id`, `key`, `name`, `stage`, `owner`, `amount`, `close_date`, `last_activity` |
| `Notes` | `key`, `at`, `marker`, `body` |

## Operations

| Operation | Implementation |
|---|---|
| `record.context` | read the four header rows; a missing tab or column: `errors=no-config` |
| `company.find` / `company.upsert` | find the row by `domain` in `Companies`; append a row, or update the empty cells of the found row |
| `person.find` / `person.upsert` | find the row by `email` in `People`; append or update |
| `deal.list_open()` | `Deals` rows whose `stage` is not `won` or `lost` |
| `deal.create` / `deal.set_stage` | append or update a `Deals` row; only under `record_writes: stages` |
| `note.add` / `note.list` | append to / filter `Notes` by `key` |
| `task.create` | none: a task becomes a `Notes` row with marker `[sales-loop] task` and the due date in the body |
| `field.set` | update the one cell |

Read the whole tab into a file once per run, work on the file, then write
only the changed cells.
