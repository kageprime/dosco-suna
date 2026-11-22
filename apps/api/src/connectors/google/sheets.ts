import { colToIndex, indexToCol, isEmptyCell, cellString, cellNumber, rowFilled, uniqueHeaders, inferType, type Json, type Cell, SqlParser, tokenize, sheetAsTable, requireColumn, compileExpr, runSelect, resultSchema, type SheetProps, type SqlTable, type Stmt, type Row } from './sheets-sql';
/**
 * Kortix Google Sheets MCP server tools. Names and arguments follow Composio's
 * Google Sheets toolkit (`values_get`, `values_update`, `upsert_rows`, …);
 * see ./tool.ts.
 *
 * Scopes: `spreadsheets` (read and write every spreadsheet the account can
 * open) and `drive` (search, export, move, Drive metadata and changes).
 *
 * Range rules every tool applies:
 *   - a sheet name that needs quotes gets them (`My Sheet!A1` → `'My Sheet'!A1`);
 *   - ranges Kortix builds always quote the sheet name and double inner quotes;
 *   - `spreadsheet_id` also accepts a full Google Sheets URL.
 *
 * The computed tools (aggregate_column_data, lookup_spreadsheet_row,
 * upsert_rows, list_tables, get_table_schema, execute_sql, query_table) read
 * the values with the Sheets API and compute the answer in Kortix.
 */
import { fileOutput } from './files';
import {
  DESTRUCTIVE,
  READ,
  ToolInputError,
  WRITE,
  anyObj,
  arr,
  b,
  i,
  mapLimit,
  n,
  optObj,
  optStr,
  reqStr,
  s,
  schema,
  strList,
  strs,
  type GoogleTool,
  type ToolAnnotations,
  type ToolContext,
} from './tool';

const S = 'https://sheets.googleapis.com/v4/spreadsheets';
const DRIVE = 'https://www.googleapis.com/drive/v3';
const SHEET_MIME = 'application/vnd.google-apps.spreadsheet';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const IDEMPOTENT: ToolAnnotations = { ...WRITE, idempotentHint: true };
const TABLE_SCAN_ROWS = 1000;

const enc = encodeURIComponent;

// ─── Argument readers ───────────────────────────────────────────────────────

/** The spreadsheet id from `spreadsheet_id` / `spreadsheetId`, or from a Sheets URL. */
function sid(args: Json, ...keys: string[]): string {
  const raw = reqStr(args, ...(keys.length ? keys : ['spreadsheet_id', 'spreadsheetId']), 'spreadsheet_id', 'spreadsheetId', 'id');
  const match = /\/spreadsheets\/d\/([A-Za-z0-9_-]+)/.exec(raw);
  return (match ? match[1]! : raw).trim();
}

function flag(args: Json, ...keys: string[]): boolean | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'boolean') return value;
    if (value === 'true') return true;
    if (value === 'false') return false;
  }
  return undefined;
}

function int(args: Json, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const raw = args[key];
    const value = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
    if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  }
  return undefined;
}

function reqInt(args: Json, ...keys: string[]): number {
  const value = int(args, ...keys);
  if (value === undefined) throw new ToolInputError(`${keys[0]} is required`);
  return value;
}

function num(args: Json, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const raw = args[key];
    const value = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

function str(args: Json, ...keys: string[]): string | undefined {
  return optStr(args, ...keys);
}

function objArg(args: Json, ...keys: string[]): Json | undefined {
  for (const key of keys) {
    const value = optObj(args, key);
    if (value) return value;
  }
  return undefined;
}

/** An array argument, also accepted as a JSON string. */
function listArg(args: Json, ...keys: string[]): unknown[] | undefined {
  for (const key of keys) {
    let value = args[key];
    if (typeof value === 'string' && /^\s*[[{]/.test(value)) {
      try {
        value = JSON.parse(value) as unknown;
      } catch {
        throw new ToolInputError(`${key} must be a JSON array`);
      }
    }
    if (Array.isArray(value)) return value;
    if (value && typeof value === 'object') return [value];
  }
  return undefined;
}

/** A 2D array of cell values. A flat list is one row. */
function values2d(args: Json, ...keys: string[]): unknown[][] {
  const value = listArg(args, ...keys);
  if (!value) throw new ToolInputError(`${keys[0]} is required: a list of rows, each a list of cell values`);
  if (!value.length) return [];
  return value.some(Array.isArray) ? value.map((row) => (Array.isArray(row) ? row : [row])) : [value];
}

function enumArg(args: Json, allowed: readonly string[], fallback: string | undefined, ...keys: string[]): string | undefined {
  const value = str(args, ...keys);
  if (value === undefined) return fallback;
  const upper = value.trim().toUpperCase();
  if (!allowed.includes(upper)) throw new ToolInputError(`${keys[0]} must be one of ${allowed.join(', ')}`);
  return upper;
}

const VALUE_RENDER = ['FORMATTED_VALUE', 'UNFORMATTED_VALUE', 'FORMULA'] as const;
const DATE_RENDER = ['SERIAL_NUMBER', 'FORMATTED_STRING'] as const;
const INPUT_OPTIONS = ['RAW', 'USER_ENTERED', 'INPUT_VALUE_OPTION_UNSPECIFIED'] as const;
const DIMENSIONS = ['ROWS', 'COLUMNS'] as const;

// ─── A1 notation ────────────────────────────────────────────────────────────

/** `'My Sheet'`, with inner quotes doubled. */
function quoteSheet(title: string): string {
  return `'${title.replace(/'/g, "''")}'`;
}

const CELLS_RE = /^\$?[A-Za-z]{0,3}\$?\d*(:\$?[A-Za-z]{0,3}\$?\d*)?$/;

/** Split `Sheet!A1:B2` into the unquoted sheet name and the cell part. */
function splitA1(range: string): { sheet?: string; cells: string } {
  const value = range.trim();
  if (value.startsWith("'")) {
    let name = '';
    let index = 1;
    while (index < value.length) {
      if (value[index] === "'") {
        if (value[index + 1] === "'") {
          name += "'";
          index += 2;
          continue;
        }
        break;
      }
      name += value[index];
      index++;
    }
    const rest = value.slice(index + 1);
    return { sheet: name, cells: rest.startsWith('!') ? rest.slice(1) : '' };
  }
  const bang = value.lastIndexOf('!');
  if (bang >= 0) return { sheet: value.slice(0, bang), cells: value.slice(bang + 1) };
  if (value && CELLS_RE.test(value) && /[A-Za-z0-9]/.test(value)) return { cells: value };
  return { sheet: value, cells: '' };
}

/** Join a sheet name and cells, quoting the name. */
function joinA1(sheet: string | undefined, cells: string): string {
  if (sheet === undefined) return cells;
  return cells ? `${quoteSheet(sheet)}!${cells}` : quoteSheet(sheet);
}

/** Quote a user range's sheet name when it needs quotes; named ranges stay as they are. */
function fixRange(range: string): string {
  const { sheet, cells } = splitA1(range);
  if (sheet === undefined) return range.trim();
  if (range.trim().startsWith("'")) return range.trim();
  if (/^[A-Za-z_][A-Za-z0-9_.]*$/.test(sheet)) return range.trim();
  return joinA1(sheet, cells);
}

interface Box {
  startRow?: number;
  endRow?: number;
  startCol?: number;
  endCol?: number;
}

function parseCellRef(ref: string): { col?: number; row?: number } | null {
  const match = /^\$?([A-Za-z]{0,3})\$?(\d*)$/.exec(ref.trim());
  if (!match || (!match[1] && !match[2])) return null;
  return { col: match[1] ? colToIndex(match[1]) : undefined, row: match[2] ? Number(match[2]) - 1 : undefined };
}

/** `A1:C3` → zero-based, end-exclusive bounds. Open sides stay undefined. */
function parseBox(cells: string): Box | null {
  if (!cells) return null;
  const [first, second] = cells.split(':');
  const start = parseCellRef(first ?? '');
  if (!start) return null;
  const end = second === undefined ? start : parseCellRef(second);
  if (!end) return null;
  return {
    startCol: start.col,
    startRow: start.row,
    endCol: end.col !== undefined ? end.col + 1 : undefined,
    endRow: end.row !== undefined ? end.row + 1 : undefined,
  };
}

function boxToCells(box: Required<Box>): string {
  return `${indexToCol(box.startCol)}${box.startRow + 1}:${indexToCol(box.endCol - 1)}${box.endRow}`;
}

function gridRange(sheetId: number, box: Box | null): Json {
  const range: Json = { sheetId };
  if (box?.startRow !== undefined) range.startRowIndex = box.startRow;
  if (box?.endRow !== undefined) range.endRowIndex = box.endRow;
  if (box?.startCol !== undefined) range.startColumnIndex = box.startCol;
  if (box?.endCol !== undefined) range.endColumnIndex = box.endCol;
  return range;
}

/** A GridRange from snake_case or camelCase keys. */
function gridFrom(value: unknown, fallbackSheetId?: number): Json {
  const o = value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {};
  const pickInt = (...keys: string[]) => int(o, ...keys);
  const sheetId = pickInt('sheetId', 'sheet_id') ?? fallbackSheetId;
  if (sheetId === undefined) throw new ToolInputError('range.sheet_id is required');
  const out: Json = { sheetId };
  const map: Array<[string, string, string]> = [
    ['startRowIndex', 'startRowIndex', 'start_row_index'],
    ['endRowIndex', 'endRowIndex', 'end_row_index'],
    ['startColumnIndex', 'startColumnIndex', 'start_column_index'],
    ['endColumnIndex', 'endColumnIndex', 'end_column_index'],
  ];
  for (const [field, camel, snake] of map) {
    const v = pickInt(camel, snake);
    if (v !== undefined) out[field] = v;
  }
  return out;
}

function a1FromGrid(title: string, grid: Json): string {
  const sr = grid.startRowIndex as number | undefined;
  const er = grid.endRowIndex as number | undefined;
  const sc = grid.startColumnIndex as number | undefined;
  const ec = grid.endColumnIndex as number | undefined;
  const start = `${sc !== undefined ? indexToCol(sc) : 'A'}${sr !== undefined ? sr + 1 : ''}`;
  const end = `${ec !== undefined ? indexToCol(ec - 1) : ''}${er !== undefined ? er : ''}`;
  if (sr === undefined && er === undefined && sc === undefined && ec === undefined) return quoteSheet(title);
  return `${quoteSheet(title)}!${start}:${end || start}`;
}

// ─── Spreadsheet helpers ────────────────────────────────────────────────────

function sheetUrl(spreadsheetId: string, gid?: number): string {
  return `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit${gid !== undefined ? `#gid=${gid}` : ''}`;
}

async function sheetsOf(ctx: ToolContext, spreadsheetId: string): Promise<SheetProps[]> {
  const result = await ctx.google.json<{ sheets?: Array<{ properties: SheetProps }> }>({
    url: `${S}/${enc(spreadsheetId)}`,
    query: { fields: 'sheets.properties' },
  });
  return (result?.sheets ?? []).map((sheet) => sheet.properties).sort((a, b) => a.index - b.index);
}

const DEFAULT_SHEET_NAME = /^(sheet|hoja|feuille|planilha|tabelle|foglio|blad|arkusz|лист|工作表|シート)\s*1$/i;

/** Exact title, then case-insensitive, then (with `partial`) a title containing the name. */
function findSheet(sheets: SheetProps[], name: string, opts: { partial?: boolean; defaultName?: boolean } = {}): SheetProps | undefined {
  const wanted = name.trim();
  const lower = wanted.toLowerCase();
  return (
    sheets.find((sheet) => sheet.title === wanted) ??
    sheets.find((sheet) => sheet.title.trim().toLowerCase() === lower) ??
    (opts.partial ? sheets.find((sheet) => sheet.title.toLowerCase().includes(lower)) : undefined) ??
    (opts.defaultName && DEFAULT_SHEET_NAME.test(wanted) ? sheets[0] : undefined)
  );
}

function noSheet(name: string, sheets: SheetProps[]): ToolInputError {
  return new ToolInputError(`No sheet named "${name}". The sheets are: ${sheets.map((sheet) => sheet.title).join(', ') || 'none'}`);
}

/** The sheet a tool targets: by name, else by id, else (with `firstSheet`) the first sheet. */
async function pickSheet(
  ctx: ToolContext,
  spreadsheetId: string,
  ref: { name?: string; id?: number; firstSheet?: boolean; partial?: boolean; defaultName?: boolean },
): Promise<{ sheet: SheetProps; sheets: SheetProps[] }> {
  const sheets = await sheetsOf(ctx, spreadsheetId);
  if (ref.name !== undefined) {
    const sheet = findSheet(sheets, ref.name, ref);
    if (!sheet) throw noSheet(ref.name, sheets);
    return { sheet, sheets };
  }
  if (ref.id !== undefined) {
    const sheet = sheets.find((candidate) => candidate.sheetId === ref.id);
    if (!sheet) throw new ToolInputError(`No sheet with sheet_id ${ref.id}. The sheet ids are: ${sheets.map((x) => `${x.sheetId} (${x.title})`).join(', ')}`);
    return { sheet, sheets };
  }
  const first = sheets.find((sheet) => !sheet.hidden) ?? sheets[0];
  if (!ref.firstSheet || !first) throw new ToolInputError('sheet_id or sheet_name is required');
  return { sheet: first, sheets };
}

/** The numeric sheet id from `sheet_name` (looked up) or `sheet_id`. */
async function sheetIdArg(ctx: ToolContext, spreadsheetId: string, args: Json, opts: { namePrecedence: boolean; fallback?: number }): Promise<number> {
  const name = str(args, 'sheet_name', 'sheetName');
  const id = int(args, 'sheet_id', 'sheetId');
  if (name !== undefined && (opts.namePrecedence || id === undefined)) return (await pickSheet(ctx, spreadsheetId, { name })).sheet.sheetId;
  if (id !== undefined) return id;
  if (opts.fallback !== undefined) return opts.fallback;
  throw new ToolInputError('sheet_id or sheet_name is required');
}

/** Grow a sheet's grid so `rows` × `cols` fit. Returns a note when it grew. */
async function ensureGrid(ctx: ToolContext, spreadsheetId: string, sheet: SheetProps, rows: number, cols: number): Promise<string> {
  const grid = sheet.gridProperties;
  if (!grid) return '';
  const requests: Json[] = [];
  if (rows > (grid.rowCount ?? 0)) requests.push({ appendDimension: { sheetId: sheet.sheetId, dimension: 'ROWS', length: rows - (grid.rowCount ?? 0) } });
  if (cols > (grid.columnCount ?? 0)) requests.push({ appendDimension: { sheetId: sheet.sheetId, dimension: 'COLUMNS', length: cols - (grid.columnCount ?? 0) } });
  if (!requests.length) return '';
  await ctx.google.json({ method: 'POST', url: `${S}/${enc(spreadsheetId)}:batchUpdate`, body: { requests } });
  return `Kortix grew sheet "${sheet.title}" to ${Math.max(rows, grid.rowCount ?? 0)} rows and ${Math.max(cols, grid.columnCount ?? 0)} columns to fit the values.`;
}

/** includeSpreadsheetInResponse and friends, from snake_case or camelCase. */
function responseOptions(args: Json, defaultInclude = false): Json {
  const include = flag(args, 'include_spreadsheet_in_response', 'includeSpreadsheetInResponse') ?? defaultInclude;
  if (!include) return {};
  const ranges = strList(args, 'response_ranges', 'responseRanges').map(fixRange);
  const gridData = flag(args, 'response_include_grid_data', 'responseIncludeGridData');
  return { includeSpreadsheetInResponse: true, ...(ranges.length ? { responseRanges: ranges } : {}), ...(gridData !== undefined ? { responseIncludeGridData: gridData } : {}) };
}

async function batchUpdate(ctx: ToolContext, spreadsheetId: string, requests: Json[], extra: Json = {}): Promise<Json> {
  const result = await ctx.google.json<Json>({ method: 'POST', url: `${S}/${enc(spreadsheetId)}:batchUpdate`, body: { requests, ...extra } });
  return { spreadsheetId, replies: [], ...result };
}

/** A batchUpdate tool's answer: Google's body plus the spreadsheet link. */
async function batchTool(ctx: ToolContext, spreadsheetId: string, requests: Json[], args: Json, gid?: number): Promise<Json> {
  const result = await batchUpdate(ctx, spreadsheetId, requests, responseOptions(args));
  return { ...result, display_url: sheetUrl(spreadsheetId, gid) };
}

/** Read a range's values; an empty range answers `[]`. */
async function readValues(ctx: ToolContext, spreadsheetId: string, range: string, query: Json = {}): Promise<{ range: string; values: unknown[][] }> {
  const result = await ctx.google.json<{ range?: string; values?: unknown[][] }>({
    url: `${S}/${enc(spreadsheetId)}/values/${enc(range)}`,
    query,
  });
  return { range: result?.range ?? range, values: result?.values ?? [] };
}

/** First row number (1-based) of a range Google answered, such as `'Sheet1'!A3:C9`. */
function firstRowOf(range: string): number {
  const box = parseBox(splitA1(range).cells);
  return box?.startRow !== undefined ? box.startRow + 1 : 1;
}

function firstColOf(range: string): number {
  const box = parseBox(splitA1(range).cells);
  return box?.startCol ?? 0;
}

const SPREADSHEET_ID = s('Spreadsheet id, the long string after /d/ in the Sheets URL. A full Sheets URL also works.');
const RESPONSE_PROPS = {
  include_spreadsheet_in_response: b('Return the updated spreadsheet resource.'),
  response_ranges: strs('Ranges of the spreadsheet to return, when include_spreadsheet_in_response is true.'),
  response_include_grid_data: b('Return cell data, when include_spreadsheet_in_response is true.'),
};
const RESPONSE_PROPS_CAMEL = {
  includeSpreadsheetInResponse: b('Return the updated spreadsheet resource.'),
  responseRanges: strs('Ranges of the spreadsheet to return, when includeSpreadsheetInResponse is true.'),
  responseIncludeGridData: b('Return cell data, when includeSpreadsheetInResponse is true.'),
};
const ROWS_SCHEMA = arr({ type: 'array', items: {} }, 'Rows of cell values: a list of rows, each a list of strings, numbers, booleans or null.');
const DATA_FILTERS = arr(
  { type: 'object', additionalProperties: true },
  'DataFilters: {"a1Range": "Sheet1!A1:B5"}, {"gridRange": {...}} or {"developerMetadataLookup": {...}}.',
);

function dataFilters(args: Json, required: boolean): Json[] {
  const filters = (listArg(args, 'dataFilters', 'data_filters') ?? []).filter((f): f is Json => !!f && typeof f === 'object');
  if (required && !filters.length) throw new ToolInputError('dataFilters is required');
  return filters.map((filter) => (typeof filter.a1Range === 'string' ? { ...filter, a1Range: fixRange(filter.a1Range) } : filter));
}

// ─── Values ─────────────────────────────────────────────────────────────────

/** Replace a range's rows with start_row..end_row (1-based, inclusive). */
async function withRows(ctx: ToolContext, spreadsheetId: string, range: string, start?: number, end?: number): Promise<string> {
  if (start === undefined && end === undefined) return range;
  const { sheet, cells } = splitA1(range);
  const box = parseBox(cells);
  const first = start ?? (box?.startRow !== undefined ? box.startRow + 1 : 1);
  const last = end ?? box?.endRow;
  let startCol = box?.startCol !== undefined ? indexToCol(box.startCol) : '';
  let endCol = box?.endCol !== undefined ? indexToCol(box.endCol - 1) : '';
  if (last === undefined && !endCol) {
    // A rows-only range needs a last row or a last column: use the sheet's width.
    const { sheet: props } = await pickSheet(ctx, spreadsheetId, { name: sheet, firstSheet: true });
    startCol ||= 'A';
    endCol = indexToCol(Math.max((props.gridProperties?.columnCount ?? 26) - 1, 0));
  }
  if (last !== undefined && last < first) throw new ToolInputError('end_row must be greater than or equal to start_row');
  return joinA1(sheet, `${startCol}${first}:${endCol}${last ?? ''}`);
}

const valuesGet: GoogleTool = {
  name: 'values_get',
  title: 'Read cell values',
  description:
    "Read the values of one range, such as `'My Sheet'!A1:D50`. Page a large sheet with start_row and end_row. A sheet name with spaces needs single quotes; Kortix adds them when missing.",
  inputSchema: schema(
    {
      spreadsheet_id: SPREADSHEET_ID,
      range: s('A1 or R1C1 range, such as Sheet1!A1:D100, Sheet1!A:C or a bare sheet name.'),
      start_row: i('First row to read, 1-based, inclusive. Overrides the range\'s first row.'),
      end_row: i('Last row to read, 1-based, inclusive. Overrides the range\'s last row.'),
      major_dimension: s('ROWS (default) or COLUMNS.', { enum: ['DIMENSION_UNSPECIFIED', 'ROWS', 'COLUMNS'] }),
      value_render_option: s('FORMATTED_VALUE, UNFORMATTED_VALUE or FORMULA.', { enum: [...VALUE_RENDER], default: 'FORMATTED_VALUE' }),
      date_time_render_option: s('SERIAL_NUMBER or FORMATTED_STRING. Used with UNFORMATTED_VALUE.', { enum: [...DATE_RENDER], default: 'SERIAL_NUMBER' }),
    },
    ['spreadsheet_id', 'range'],
  ),
  annotations: READ,
  async run(args, ctx) {
    const id = sid(args);
    const range = await withRows(ctx, id, fixRange(reqStr(args, 'range')), int(args, 'start_row', 'startRow'), int(args, 'end_row', 'endRow'));
    const result = await ctx.google.json<Json>({
      url: `${S}/${enc(id)}/values/${enc(range)}`,
      query: {
        majorDimension: enumArg(args, ['DIMENSION_UNSPECIFIED', ...DIMENSIONS], undefined, 'major_dimension', 'majorDimension'),
        valueRenderOption: enumArg(args, VALUE_RENDER, 'FORMATTED_VALUE', 'value_render_option', 'valueRenderOption'),
        dateTimeRenderOption: enumArg(args, DATE_RENDER, 'SERIAL_NUMBER', 'date_time_render_option', 'dateTimeRenderOption'),
      },
    });
    return { range, majorDimension: 'ROWS', values: [], ...result, display_url: sheetUrl(id) };
  },
};

/** Fit a start-cell range to the values; `A1` with 3×2 values becomes `A1:B3`. */
function fitRange(range: string, values: unknown[][], columns: boolean): { range: string; box: Required<Box> | null; sheet?: string } {
  const { sheet, cells } = splitA1(range);
  const box = parseBox(cells);
  if (!box || box.startRow === undefined || box.startCol === undefined || !values.length) return { range: fixRange(range), box: null, sheet };
  const width = Math.max(0, ...values.map((row) => row.length));
  const rows = columns ? width : values.length;
  const cols = columns ? values.length : width;
  if (!rows || !cols) return { range: fixRange(range), box: null, sheet };
  const fitted: Required<Box> = { startRow: box.startRow, startCol: box.startCol, endRow: box.startRow + rows, endCol: box.startCol + cols };
  return { range: sheet !== undefined ? joinA1(sheet, boxToCells(fitted)) : boxToCells(fitted), box: fitted, sheet };
}

/** Resolve the target sheet of a write, grow its grid, and rewrite the range with its real title. */
async function prepareWrite(ctx: ToolContext, spreadsheetId: string, range: string, values: unknown[][], columns: boolean, grow: boolean): Promise<{ range: string; note: string }> {
  const fitted = fitRange(range, values, columns);
  if (!fitted.box || !grow) return { range: fitted.range, note: '' };
  const { sheet } = await pickSheet(ctx, spreadsheetId, { name: fitted.sheet, firstSheet: true, defaultName: true });
  const note = await ensureGrid(ctx, spreadsheetId, sheet, fitted.box.endRow, fitted.box.endCol);
  const renamed = fitted.sheet !== undefined && fitted.sheet !== sheet.title;
  return { range: joinA1(sheet.title, boxToCells(fitted.box)), note: [note, renamed ? `Kortix wrote to sheet "${sheet.title}" (no sheet is named "${fitted.sheet}").` : ''].filter(Boolean).join(' ') };
}

const valuesUpdate: GoogleTool = {
  name: 'values_update',
  title: 'Write cell values',
  description:
    'Write rows of values into a range, overwriting what is there. The range grows from its first cell to fit the values. auto_expand_sheet adds rows and columns when the values go past the grid.',
  inputSchema: schema(
    {
      spreadsheet_id: SPREADSHEET_ID,
      range: s("Target range or its first cell, such as Sheet1!A1 or 'My Sheet'!B2:D4. Without a sheet name, the first visible sheet."),
      values: ROWS_SCHEMA,
      value_input_option: s('USER_ENTERED parses values as typed in the UI (formulas, dates, numbers); RAW stores them as given.', { enum: ['RAW', 'USER_ENTERED'], default: 'USER_ENTERED' }),
      major_dimension: s('ROWS (default): each inner list is a row. COLUMNS: each inner list is a column.', { enum: [...DIMENSIONS] }),
      auto_expand_sheet: b('Add rows and columns when the values go past the sheet grid.', { default: true }),
      include_values_in_response: b('Return the written values.'),
      response_value_render_option: s('How returned values render.', { enum: [...VALUE_RENDER] }),
      response_datetime_render_option: s('How returned dates render.', { enum: [...DATE_RENDER] }),
    },
    ['spreadsheet_id', 'range', 'value_input_option', 'values'],
  ),
  annotations: IDEMPOTENT,
  async run(args, ctx) {
    const id = sid(args);
    const values = values2d(args, 'values');
    const major = enumArg(args, DIMENSIONS, 'ROWS', 'major_dimension', 'majorDimension')!;
    const grow = flag(args, 'auto_expand_sheet', 'autoExpandSheet') ?? true;
    const { range, note } = await prepareWrite(ctx, id, reqStr(args, 'range'), values, major === 'COLUMNS', grow);
    const result = await ctx.google.json<Json>({
      method: 'PUT',
      url: `${S}/${enc(id)}/values/${enc(range)}`,
      query: {
        valueInputOption: enumArg(args, INPUT_OPTIONS, 'USER_ENTERED', 'value_input_option', 'valueInputOption'),
        includeValuesInResponse: flag(args, 'include_values_in_response', 'includeValuesInResponse'),
        responseValueRenderOption: enumArg(args, VALUE_RENDER, undefined, 'response_value_render_option', 'responseValueRenderOption'),
        responseDateTimeRenderOption: enumArg(args, DATE_RENDER, undefined, 'response_datetime_render_option', 'responseDateTimeRenderOption'),
      },
      body: { range, majorDimension: major, values },
    });
    return { ...result, display_url: sheetUrl(id), ...(note ? { composio_execution_message: note } : {}) };
  },
};

async function firstSheetRange(ctx: ToolContext, spreadsheetId: string): Promise<string> {
  const { sheet } = await pickSheet(ctx, spreadsheetId, { firstSheet: true });
  return quoteSheet(sheet.title);
}

async function batchGetValues(ctx: ToolContext, spreadsheetId: string, ranges: string[], query: Json): Promise<Json> {
  const result = await ctx.google.json<Json>({ url: `${S}/${enc(spreadsheetId)}/values:batchGet`, query: { ranges, ...query } });
  return { spreadsheetId, valueRanges: [], ...result };
}

const batchGet: GoogleTool = {
  name: 'batch_get',
  title: 'Read several ranges',
  description: 'Read the values of several ranges in one call. With no ranges, Kortix reads the whole first sheet.',
  inputSchema: schema(
    {
      spreadsheet_id: SPREADSHEET_ID,
      ranges: strs("A1 ranges, such as ['Sheet1!A1:B10', \"'My Sheet'!C:C\"]. Blank entries are dropped."),
      majorDimension: s('ROWS or COLUMNS.', { enum: ['DIMENSION_UNSPECIFIED', 'ROWS', 'COLUMNS'] }),
      valueRenderOption: s('FORMATTED_VALUE, UNFORMATTED_VALUE or FORMULA.', { enum: [...VALUE_RENDER], default: 'FORMATTED_VALUE' }),
      dateTimeRenderOption: s('SERIAL_NUMBER or FORMATTED_STRING.', { enum: [...DATE_RENDER], default: 'SERIAL_NUMBER' }),
      empty_strings_filtered: b('Unused; blank ranges are always dropped.', { default: false }),
    },
    ['spreadsheet_id'],
  ),
  annotations: READ,
  async run(args, ctx) {
    const id = sid(args);
    let ranges = strList(args, 'ranges').map(fixRange);
    const message = ranges.length ? undefined : 'No ranges were given: Kortix read the whole first sheet.';
    if (!ranges.length) ranges = [await firstSheetRange(ctx, id)];
    const result = await batchGetValues(ctx, id, ranges, {
      majorDimension: enumArg(args, ['DIMENSION_UNSPECIFIED', ...DIMENSIONS], undefined, 'majorDimension', 'major_dimension'),
      valueRenderOption: enumArg(args, VALUE_RENDER, 'FORMATTED_VALUE', 'valueRenderOption', 'value_render_option'),
      dateTimeRenderOption: enumArg(args, DATE_RENDER, 'SERIAL_NUMBER', 'dateTimeRenderOption', 'date_time_render_option'),
    });
    return { ...result, display_url: sheetUrl(id), ...(message ? { composio_execution_message: message } : {}) };
  },
};

const getBatchValues: GoogleTool = {
  name: 'get_batch_values',
  title: 'Read several ranges (old name)',
  description: 'Read the values of several ranges in one call. Same as batch_get.',
  inputSchema: schema(
    {
      spreadsheet_id: SPREADSHEET_ID,
      ranges: strs('A1 or R1C1 ranges.'),
      major_dimension: s('ROWS or COLUMNS.', { enum: ['DIMENSION_UNSPECIFIED', 'ROWS', 'COLUMNS'] }),
      value_render_option: s('FORMATTED_VALUE, UNFORMATTED_VALUE or FORMULA.', { enum: [...VALUE_RENDER] }),
      date_time_render_option: s('SERIAL_NUMBER or FORMATTED_STRING.', { enum: [...DATE_RENDER] }),
    },
    ['spreadsheet_id', 'ranges'],
  ),
  annotations: READ,
  async run(args, ctx) {
    const id = sid(args);
    const ranges = strList(args, 'ranges').map(fixRange);
    if (!ranges.length) throw new ToolInputError('ranges is required');
    return batchGetValues(ctx, id, ranges, {
      majorDimension: enumArg(args, ['DIMENSION_UNSPECIFIED', ...DIMENSIONS], undefined, 'major_dimension', 'majorDimension'),
      valueRenderOption: enumArg(args, VALUE_RENDER, undefined, 'value_render_option', 'valueRenderOption'),
      dateTimeRenderOption: enumArg(args, DATE_RENDER, undefined, 'date_time_render_option', 'dateTimeRenderOption'),
    });
  },
};

const RESPONSE_RENDER_PROPS = {
  includeValuesInResponse: b('Return the written values.'),
  responseValueRenderOption: s('How returned values render.', { enum: [...VALUE_RENDER] }),
  responseDateTimeRenderOption: s('How returned dates render.', { enum: [...DATE_RENDER] }),
};

function responseRender(args: Json): Json {
  return {
    includeValuesInResponse: flag(args, 'includeValuesInResponse', 'include_values_in_response'),
    responseValueRenderOption: enumArg(args, VALUE_RENDER, undefined, 'responseValueRenderOption', 'response_value_render_option'),
    responseDateTimeRenderOption: enumArg(args, DATE_RENDER, undefined, 'responseDateTimeRenderOption', 'response_datetime_render_option', 'response_date_time_render_option'),
  };
}

const updateValuesBatch: GoogleTool = {
  name: 'update_values_batch',
  title: 'Write several ranges',
  description: 'Write values into several ranges in one call. Each data item is {range, values, majorDimension}.',
  inputSchema: schema(
    {
      spreadsheet_id: SPREADSHEET_ID,
      data: arr(
        { type: 'object', properties: { range: s('A1 range.'), values: ROWS_SCHEMA, majorDimension: s('ROWS or COLUMNS.') }, required: ['range', 'values'] },
        'The ranges and values to write.',
      ),
      valueInputOption: s('USER_ENTERED or RAW.', { enum: [...INPUT_OPTIONS], default: 'USER_ENTERED' }),
      ...RESPONSE_RENDER_PROPS,
    },
    ['spreadsheet_id', 'valueInputOption', 'data'],
  ),
  annotations: IDEMPOTENT,
  async run(args, ctx) {
    const id = sid(args);
    const data = (listArg(args, 'data') ?? []).map((item, index) => {
      if (!item || typeof item !== 'object') throw new ToolInputError(`data[${index}] must be an object`);
      const entry = item as Json;
      const range = optStr(entry, 'range');
      if (!range) throw new ToolInputError(`data[${index}].range is required`);
      const values = values2d(entry, 'values');
      const major = enumArg(entry, DIMENSIONS, 'ROWS', 'majorDimension', 'major_dimension')!;
      return { range: fitRange(range, values, major === 'COLUMNS').range, majorDimension: major, values };
    });
    if (!data.length) throw new ToolInputError('data is required');
    const result = await ctx.google.json<Json>({
      method: 'POST',
      url: `${S}/${enc(id)}/values:batchUpdate`,
      body: { valueInputOption: enumArg(args, INPUT_OPTIONS, 'USER_ENTERED', 'valueInputOption', 'value_input_option'), data, ...responseRender(args) },
    });
    return { spreadsheetId: id, ...result, display_url: sheetUrl(id) };
  },
};

const valuesAppend: GoogleTool = {
  name: 'spreadsheets_values_append',
  title: 'Append rows',
  description: 'Append rows after the last row of the table found in range. Use the sheet name as range, such as Sheet1 or \'My Sheet\'!A:D.',
  inputSchema: schema(
    {
      spreadsheetId: SPREADSHEET_ID,
      range: s('A1 range that locates the table, such as Sheet1 or Sheet1!A:D.'),
      values: ROWS_SCHEMA,
      valueInputOption: s('USER_ENTERED or RAW.', { enum: ['RAW', 'USER_ENTERED'], default: 'USER_ENTERED' }),
      insertDataOption: s('INSERT_ROWS adds new rows; OVERWRITE writes over empty cells below the table.', { enum: ['OVERWRITE', 'INSERT_ROWS'] }),
      majorDimension: s('ROWS (default) or COLUMNS.', { enum: [...DIMENSIONS] }),
      ...RESPONSE_RENDER_PROPS,
    },
    ['spreadsheetId', 'range', 'valueInputOption', 'values'],
  ),
  annotations: WRITE,
  async run(args, ctx) {
    const id = sid(args, 'spreadsheetId', 'spreadsheet_id');
    const range = fixRange(reqStr(args, 'range'));
    const result = await ctx.google.json<Json>({
      method: 'POST',
      url: `${S}/${enc(id)}/values/${enc(range)}:append`,
      query: {
        valueInputOption: enumArg(args, INPUT_OPTIONS, 'USER_ENTERED', 'valueInputOption', 'value_input_option'),
        insertDataOption: enumArg(args, ['OVERWRITE', 'INSERT_ROWS'], undefined, 'insertDataOption', 'insert_data_option'),
        ...responseRender(args),
      },
      body: { range, majorDimension: enumArg(args, DIMENSIONS, 'ROWS', 'majorDimension', 'major_dimension'), values: values2d(args, 'values') },
    });
    return { spreadsheetId: id, ...result, display_url: sheetUrl(id) };
  },
};

const clearValues: GoogleTool = {
  name: 'clear_values',
  title: 'Clear a range',
  description: 'Clear the values of one range. Formatting and notes stay.',
  inputSchema: schema({ spreadsheet_id: SPREADSHEET_ID, range: s('A1 range, such as Sheet1!A1:B2 or Sheet1!C:C.') }, ['spreadsheet_id', 'range']),
  annotations: DESTRUCTIVE,
  async run(args, ctx) {
    const id = sid(args);
    const range = fixRange(reqStr(args, 'range'));
    const result = await ctx.google.json<Json>({ method: 'POST', url: `${S}/${enc(id)}/values/${enc(range)}:clear`, body: {} });
    return { spreadsheetId: id, clearedRange: range, ...result, display_url: sheetUrl(id) };
  },
};

const valuesBatchClear: GoogleTool = {
  name: 'spreadsheets_values_batch_clear',
  title: 'Clear several ranges',
  description: 'Clear the values of several ranges. Formatting stays.',
  inputSchema: schema({ spreadsheet_id: SPREADSHEET_ID, ranges: strs('A1 ranges, such as Sheet1!A1:B2 or Sheet1.') }, ['spreadsheet_id', 'ranges']),
  annotations: DESTRUCTIVE,
  async run(args, ctx) {
    const id = sid(args);
    const ranges = strList(args, 'ranges').map((range) => fixRange(range.replace(/^\[?['"]?|['"]?\]?$/g, '')));
    if (!ranges.length) throw new ToolInputError('ranges is required');
    const result = await ctx.google.json<Json>({ method: 'POST', url: `${S}/${enc(id)}/values:batchClear`, body: { ranges } });
    return { spreadsheetId: id, clearedRanges: [], ...result, display_url: sheetUrl(id) };
  },
};

const batchClearByDataFilter: GoogleTool = {
  name: 'batch_clear_values_by_data_filter',
  title: 'Clear ranges by data filter',
  description: 'Clear the values of every range a data filter matches. Formatting stays.',
  inputSchema: schema({ spreadsheetId: SPREADSHEET_ID, dataFilters: DATA_FILTERS }, ['spreadsheetId', 'dataFilters']),
  annotations: DESTRUCTIVE,
  async run(args, ctx) {
    const id = sid(args, 'spreadsheetId', 'spreadsheet_id');
    const result = await ctx.google.json<Json>({ method: 'POST', url: `${S}/${enc(id)}/values:batchClearByDataFilter`, body: { dataFilters: dataFilters(args, true) } });
    return { spreadsheetId: id, clearedRanges: [], ...result, display_url: sheetUrl(id) };
  },
};

const valuesBatchGetByDataFilter: GoogleTool = {
  name: 'spreadsheets_values_batch_get_by_data_filter',
  title: 'Read ranges by data filter',
  description: 'Read the values of every range a data filter matches, such as [{"a1Range": "Sheet1!A1:B5"}].',
  inputSchema: schema(
    {
      spreadsheetId: SPREADSHEET_ID,
      dataFilters: DATA_FILTERS,
      majorDimension: s('ROWS or COLUMNS.', { enum: [...DIMENSIONS] }),
      valueRenderOption: s('FORMATTED_VALUE, UNFORMATTED_VALUE or FORMULA.', { enum: [...VALUE_RENDER] }),
      dateTimeRenderOption: s('SERIAL_NUMBER or FORMATTED_STRING.', { enum: [...DATE_RENDER] }),
    },
    ['spreadsheetId', 'dataFilters'],
  ),
  annotations: READ,
  async run(args, ctx) {
    const id = sid(args, 'spreadsheetId', 'spreadsheet_id');
    const result = await ctx.google.json<Json>({
      method: 'POST',
      url: `${S}/${enc(id)}/values:batchGetByDataFilter`,
      body: {
        dataFilters: dataFilters(args, true),
        majorDimension: enumArg(args, DIMENSIONS, undefined, 'majorDimension', 'major_dimension'),
        valueRenderOption: enumArg(args, VALUE_RENDER, undefined, 'valueRenderOption', 'value_render_option'),
        dateTimeRenderOption: enumArg(args, DATE_RENDER, undefined, 'dateTimeRenderOption', 'date_time_render_option'),
      },
    });
    return { spreadsheetId: id, valueRanges: [], ...result, display_url: sheetUrl(id) };
  },
};

const batchUpdateByDataFilter: GoogleTool = {
  name: 'batch_update_values_by_data_filter',
  title: 'Write ranges by data filter',
  description: 'Write values into every range a data filter matches. Each data item is {dataFilter, values, majorDimension}.',
  inputSchema: schema(
    {
      spreadsheetId: SPREADSHEET_ID,
      data: arr({ type: 'object', additionalProperties: true }, 'DataFilterValueRange items: {"dataFilter": {"a1Range": "Sheet1!A1"}, "values": [[...]]}.'),
      valueInputOption: s('USER_ENTERED or RAW.', { enum: [...INPUT_OPTIONS] }),
      includeValuesInResponse: b('Return the written values.', { default: false }),
      responseValueRenderOption: s('How returned values render.', { enum: [...VALUE_RENDER], default: 'FORMATTED_VALUE' }),
      responseDateTimeRenderOption: s('How returned dates render.', { enum: [...DATE_RENDER], default: 'SERIAL_NUMBER' }),
    },
    ['spreadsheetId', 'data', 'valueInputOption'],
  ),
  annotations: IDEMPOTENT,
  async run(args, ctx) {
    const id = sid(args, 'spreadsheetId', 'spreadsheet_id');
    const data = (listArg(args, 'data') ?? []).map((item, index) => {
      if (!item || typeof item !== 'object') throw new ToolInputError(`data[${index}] must be an object`);
      const entry = item as Json;
      const filter = entry.dataFilter as Json | undefined;
      if (!filter || typeof filter !== 'object') throw new ToolInputError(`data[${index}].dataFilter is required`);
      return {
        ...entry,
        dataFilter: typeof filter.a1Range === 'string' ? { ...filter, a1Range: fixRange(filter.a1Range) } : filter,
        values: values2d(entry, 'values'),
      };
    });
    if (!data.length) throw new ToolInputError('data is required');
    const result = await ctx.google.json<Json>({
      method: 'POST',
      url: `${S}/${enc(id)}/values:batchUpdateByDataFilter`,
      body: { data, valueInputOption: enumArg(args, INPUT_OPTIONS, 'USER_ENTERED', 'valueInputOption', 'value_input_option'), ...responseRender(args) },
    });
    return { spreadsheetId: id, ...result, display_url: sheetUrl(id) };
  },
};

const batchUpdateDeprecated: GoogleTool = {
  name: 'batch_update',
  title: 'Write or append rows (old)',
  description:
    'Write rows into a sheet from first_cell_location, or append them after the last row when first_cell_location is omitted. Prefer values_update and spreadsheets_values_append.',
  inputSchema: schema(
    {
      spreadsheet_id: SPREADSHEET_ID,
      sheet_name: s('Sheet name; matched case-insensitively. A default name such as Sheet1 falls back to the first sheet.'),
      values: ROWS_SCHEMA,
      first_cell_location: s('First cell without a sheet name, such as A1 or B5. Omit to append.'),
      value_input_option: s('USER_ENTERED or RAW.', { enum: ['RAW', 'USER_ENTERED'], default: 'USER_ENTERED' }),
      include_values_in_response: b('Return the written values.', { default: false }),
    },
    ['spreadsheet_id', 'sheet_name', 'values'],
  ),
  annotations: WRITE,
  async run(args, ctx) {
    const id = sid(args);
    const values = values2d(args, 'values');
    if (!values.length) throw new ToolInputError('values must have at least one row');
    const { sheet } = await pickSheet(ctx, id, { name: reqStr(args, 'sheet_name', 'sheetName'), defaultName: true });
    const inputOption = enumArg(args, INPUT_OPTIONS, 'USER_ENTERED', 'value_input_option', 'valueInputOption');
    const includeValues = flag(args, 'include_values_in_response', 'includeValuesInResponse') ?? false;
    const start = str(args, 'first_cell_location');
    if (!start) {
      const appended = await ctx.google.json<{ updates?: Json }>({
        method: 'POST',
        url: `${S}/${enc(id)}/values/${enc(quoteSheet(sheet.title))}:append`,
        query: { valueInputOption: inputOption, insertDataOption: 'INSERT_ROWS', includeValuesInResponse: includeValues },
        body: { values },
      });
      const updates = appended?.updates ?? {};
      return {
        spreadsheet: { spreadsheetId: id, responses: [updates], totalUpdatedRows: updates.updatedRows, totalUpdatedColumns: updates.updatedColumns, totalUpdatedCells: updates.updatedCells, totalUpdatedSheets: 1 },
        display_url: sheetUrl(id, sheet.sheetId),
      };
    }
    const cell = splitA1(start).cells || start;
    const { range, note } = await prepareWrite(ctx, id, joinA1(sheet.title, cell), values, false, true);
    const result = await ctx.google.json<Json>({
      method: 'POST',
      url: `${S}/${enc(id)}/values:batchUpdate`,
      body: { valueInputOption: inputOption, includeValuesInResponse: includeValues, data: [{ range, majorDimension: 'ROWS', values }] },
    });
    return { spreadsheet: result, display_url: sheetUrl(id, sheet.sheetId), ...(note ? { composio_execution_message: note } : {}) };
  },
};

// ─── Spreadsheets and sheets ────────────────────────────────────────────────

/** Drive query literal: backslashes and single quotes escaped. */
function driveLiteral(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/** Move a Drive file into one folder, out of its old parents. */
async function moveToFolder(ctx: ToolContext, fileId: string, folderId: string): Promise<{ name?: string; mimeType?: string; parents: string[]; previous: string[] }> {
  const before = await ctx.google.json<{ parents?: string[] }>({ url: `${DRIVE}/files/${enc(fileId)}`, query: { fields: 'parents', supportsAllDrives: true } });
  const previous = before?.parents ?? [];
  const after = await ctx.google.json<{ name?: string; mimeType?: string; parents?: string[] }>({
    method: 'PATCH',
    url: `${DRIVE}/files/${enc(fileId)}`,
    query: { addParents: folderId, removeParents: previous.filter((p) => p !== folderId).join(','), supportsAllDrives: true, fields: 'id,name,mimeType,parents' },
    body: {},
  });
  return { name: after?.name, mimeType: after?.mimeType, parents: after?.parents ?? [], previous };
}

const createGoogleSheet: GoogleTool = {
  name: 'create_google_sheet1',
  title: 'Create spreadsheet',
  description:
    'Create a spreadsheet, optionally in a folder (folder_id, or folder_name matched exactly). When several folders share folder_name, nothing is created and the matches come back to choose from.',
  inputSchema: schema({
    title: s('Spreadsheet title. Google uses "Untitled spreadsheet" when omitted.'),
    folder_id: s('Drive folder id to put the spreadsheet in. Wins over folder_name.'),
    folder_name: s('Exact name of the Drive folder to put the spreadsheet in.'),
  }),
  annotations: WRITE,
  async run(args, ctx) {
    let folderId = str(args, 'folder_id', 'folderId');
    const folderName = str(args, 'folder_name', 'folderName');
    let resolvedName: string | undefined;
    if (!folderId && folderName) {
      const found = await ctx.google.json<{ files?: Array<{ id: string; name: string }> }>({
        url: `${DRIVE}/files`,
        query: {
          q: `mimeType='${FOLDER_MIME}' and name=${driveLiteral(folderName)} and trashed=false`,
          fields: 'files(id,name)',
          pageSize: 20,
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
        },
      });
      const folders = found?.files ?? [];
      if (!folders.length) throw new ToolInputError(`No Drive folder is named "${folderName}". Pass folder_id, or create the folder first.`);
      if (folders.length > 1) {
        return {
          requires_user_selection: true,
          matching_folders: folders.map((f) => ({ id: f.id, name: f.name })),
          composio_execution_message: `${folders.length} folders are named "${folderName}". Call again with folder_id.`,
        };
      }
      folderId = folders[0]!.id;
      resolvedName = folders[0]!.name;
    }
    const title = str(args, 'title');
    const created = await ctx.google.json<Json & { spreadsheetId: string }>({ method: 'POST', url: S, body: title ? { properties: { title } } : {} });
    const out: Json = { ...created, display_url: created.spreadsheetUrl ?? sheetUrl(created.spreadsheetId) };
    if (!folderId) return out;
    try {
      await moveToFolder(ctx, created.spreadsheetId, folderId);
      return { ...out, folder_id: folderId, ...(resolvedName ? { folder_name: resolvedName } : {}) };
    } catch (error) {
      return { ...out, composio_execution_message: `The spreadsheet was created in My Drive, but moving it to folder ${folderId} failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  },
};

function cellText(value: unknown): Cell {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  return JSON.stringify(value);
}

const sheetFromJson: GoogleTool = {
  name: 'sheet_from_json',
  title: 'Create spreadsheet from JSON',
  description:
    'Create a spreadsheet whose first sheet holds a list of JSON objects: one header row from the keys, one row per object. Values are stored as given (RAW).',
  inputSchema: schema(
    {
      title: s('Spreadsheet title.'),
      sheet_name: s('Name of the first sheet.'),
      sheet_json: arr({ type: 'object', additionalProperties: true }, 'Rows as objects, such as [{"Name": "Ada", "Score": 9}]. An empty list creates an empty sheet.'),
    },
    ['title', 'sheet_name', 'sheet_json'],
  ),
  annotations: WRITE,
  async run(args, ctx) {
    const rows = (listArg(args, 'sheet_json', 'sheetJson') ?? []).filter((row): row is Json => !!row && typeof row === 'object' && !Array.isArray(row));
    const headers: string[] = [];
    for (const row of rows) for (const key of Object.keys(row)) if (!headers.includes(key)) headers.push(key);
    const sheetName = reqStr(args, 'sheet_name', 'sheetName');
    const grid = { rowCount: Math.max(1000, rows.length + 1), columnCount: Math.max(26, headers.length) };
    const created = await ctx.google.json<{ spreadsheetId: string; spreadsheetUrl?: string }>({
      method: 'POST',
      url: S,
      body: { properties: { title: reqStr(args, 'title') }, sheets: [{ properties: { title: sheetName, gridProperties: grid } }] },
    });
    const id = created.spreadsheetId;
    const display = created.spreadsheetUrl ?? sheetUrl(id);
    if (!headers.length) return { spreadsheetId: id, updatedRows: 0, updatedColumns: 0, updatedCells: 0, display_url: display };
    const values = [headers, ...rows.map((row) => headers.map((key) => cellText(row[key])))];
    const range = joinA1(sheetName, boxToCells({ startRow: 0, startCol: 0, endRow: values.length, endCol: headers.length }));
    const result = await ctx.google.json<Json>({ method: 'PUT', url: `${S}/${enc(id)}/values/${enc(range)}`, query: { valueInputOption: 'RAW' }, body: { range, values } });
    return { ...result, spreadsheetId: id, display_url: display };
  },
};

const DEFAULT_INFO_FIELDS = 'spreadsheetId,spreadsheetUrl,properties,sheets.properties,namedRanges';

const getSpreadsheetInfo: GoogleTool = {
  name: 'get_spreadsheet_info',
  title: 'Get spreadsheet info',
  description:
    'Spreadsheet metadata: title, locale, time zone, and every sheet with its sheetId, title, index and grid size. fields picks other parts, such as `sheets(properties,charts)` or `*`.',
  inputSchema: schema(
    {
      spreadsheet_id: SPREADSHEET_ID,
      fields: s(`Google field mask. Default: ${DEFAULT_INFO_FIELDS}.`),
      ranges: strs('Ranges to limit the answer to.'),
      include_grid_data: b('Include cell data (ignored when fields is set).'),
      exclude_tables_in_banded_ranges: b('Leave tables out of banded ranges.'),
    },
    ['spreadsheet_id'],
  ),
  annotations: READ,
  async run(args, ctx) {
    const id = sid(args);
    const fields = str(args, 'fields');
    const gridData = flag(args, 'include_grid_data', 'includeGridData');
    const result = await ctx.google.json<Json>({
      url: `${S}/${enc(id)}`,
      query: {
        fields: fields ?? (gridData ? undefined : DEFAULT_INFO_FIELDS),
        ranges: strList(args, 'ranges').map(fixRange),
        includeGridData: fields ? undefined : gridData,
        excludeTablesInBandedRanges: flag(args, 'exclude_tables_in_banded_ranges', 'excludeTablesInBandedRanges'),
      },
    });
    return { spreadsheetId: id, ...result, display_url: (result?.spreadsheetUrl as string | undefined) ?? sheetUrl(id) };
  },
};

const getSheetNames: GoogleTool = {
  name: 'get_sheet_names',
  title: 'List sheet names',
  description: 'The names of every sheet (tab), in tab order. exclude_hidden drops hidden sheets.',
  inputSchema: schema({ spreadsheet_id: SPREADSHEET_ID, exclude_hidden: b('Leave hidden sheets out.', { default: false }) }, ['spreadsheet_id']),
  annotations: READ,
  async run(args, ctx) {
    const id = sid(args);
    const sheets = await sheetsOf(ctx, id);
    const names = sheets.filter((sheet) => !(flag(args, 'exclude_hidden', 'excludeHidden') && sheet.hidden)).map((sheet) => sheet.title);
    return { sheet_names: names, sheets: names, display_url: sheetUrl(id) };
  },
};

const findWorksheetByTitle: GoogleTool = {
  name: 'find_worksheet_by_title',
  title: 'Find sheet by title',
  description: 'Find a sheet by its exact, case-sensitive title. Returns found and the sheet properties (sheetId, index, grid size).',
  inputSchema: schema({ spreadsheet_id: SPREADSHEET_ID, worksheet_title: s('Exact sheet title.') }, ['spreadsheet_id', 'worksheet_title']),
  annotations: READ,
  async run(args, ctx) {
    const id = sid(args);
    const title = reqStr(args, 'worksheet_title', 'title').trim().replace(/\\u([0-9a-fA-F]{4})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));
    const sheet = (await sheetsOf(ctx, id)).find((candidate) => candidate.title === title);
    return sheet ? { found: true, sheet_data: { properties: sheet }, display_url: sheetUrl(id, sheet.sheetId) } : { found: false, sheet_data: null, display_url: null };
  },
};

const getSpreadsheetByDataFilter: GoogleTool = {
  name: 'get_spreadsheet_by_data_filter',
  title: 'Get spreadsheet by data filter',
  description: 'The spreadsheet limited to the ranges the data filters match. With no filters, the whole spreadsheet metadata.',
  inputSchema: schema(
    {
      spreadsheetId: SPREADSHEET_ID,
      dataFilters: DATA_FILTERS,
      includeGridData: b('Include cell data.'),
      excludeTablesInBandedRanges: b('Leave tables out of banded ranges.'),
    },
    ['spreadsheetId'],
  ),
  annotations: READ,
  async run(args, ctx) {
    const id = sid(args, 'spreadsheetId', 'spreadsheet_id');
    const result = await ctx.google.json<Json>({
      method: 'POST',
      url: `${S}/${enc(id)}:getByDataFilter`,
      body: {
        dataFilters: dataFilters(args, false),
        includeGridData: flag(args, 'includeGridData', 'include_grid_data'),
        excludeTablesInBandedRanges: flag(args, 'excludeTablesInBandedRanges', 'exclude_tables_in_banded_ranges'),
      },
    });
    return { spreadsheetId: id, ...result, display_url: (result?.spreadsheetUrl as string | undefined) ?? sheetUrl(id) };
  },
};

const addSheet: GoogleTool = {
  name: 'add_sheet',
  title: 'Add sheet',
  description: 'Add a sheet (tab). With force_unique, a taken name gets a suffix (_2, _3). properties sets size, tab color, position and visibility.',
  inputSchema: schema(
    {
      spreadsheet_id: SPREADSHEET_ID,
      title: s('Name of the new sheet. sheet_name is an alias.'),
      properties: anyObj('SheetProperties: index, hidden, rightToLeft, tabColorStyle, gridProperties {rowCount, columnCount, frozenRowCount}.'),
      force_unique: b('Add a numeric suffix when the name is taken.', { default: true }),
    },
    ['spreadsheet_id'],
  ),
  annotations: WRITE,
  async run(args, ctx) {
    const id = sid(args);
    const properties: Json = { ...(objArg(args, 'properties') ?? {}) };
    let title = str(args, 'title', 'sheet_name', 'sheetName') ?? (typeof properties.title === 'string' ? properties.title : undefined);
    let message: string | undefined;
    if (title && (flag(args, 'force_unique', 'forceUnique') ?? true)) {
      const taken = new Set((await sheetsOf(ctx, id)).map((sheet) => sheet.title.toLowerCase()));
      const wanted = title;
      for (let suffix = 2; taken.has(title.toLowerCase()); suffix++) title = `${wanted}_${suffix}`;
      if (title !== wanted) message = `A sheet named "${wanted}" exists; Kortix named the new sheet "${title}".`;
    }
    if (title) properties.title = title;
    const result = await batchUpdate(ctx, id, [{ addSheet: { properties } }]);
    const added = (result.replies as Array<{ addSheet?: { properties?: SheetProps } }> | undefined)?.[0]?.addSheet?.properties;
    return { ...result, display_url: sheetUrl(id, added?.sheetId), ...(message ? { composio_execution_message: message } : {}) };
  },
};

const deleteSheet: GoogleTool = {
  name: 'delete_sheet',
  title: 'Delete sheet',
  description: 'Delete a sheet (tab) and its data. The last sheet of a spreadsheet cannot be deleted.',
  inputSchema: schema({ spreadsheetId: SPREADSHEET_ID, sheetId: i('Numeric sheet id (gid).'), ...RESPONSE_PROPS_CAMEL }, ['spreadsheetId', 'sheetId']),
  annotations: DESTRUCTIVE,
  run: (args, ctx) => {
    const id = sid(args, 'spreadsheetId', 'spreadsheet_id');
    return batchTool(ctx, id, [{ deleteSheet: { sheetId: reqInt(args, 'sheetId', 'sheet_id') } }], args);
  },
};

/** A field mask from the keys that are set; gridProperties and iterative settings list their leaves. */
function fieldMask(properties: Json, skip: string[] = []): string {
  const fields: string[] = [];
  for (const [key, value] of Object.entries(properties)) {
    if (skip.includes(key) || value === undefined) continue;
    if ((key === 'gridProperties' || key === 'iterativeCalculationSettings') && value && typeof value === 'object') {
      for (const inner of Object.keys(value as Json)) fields.push(`${key}.${inner}`);
    } else {
      fields.push(key);
    }
  }
  return fields.join(',');
}

const updateSheetProperties: GoogleTool = {
  name: 'update_sheet_properties',
  title: 'Update sheet properties',
  description:
    'Rename, move, hide, color or resize a sheet. updateSheetProperties is {properties: {sheetId, title, index, hidden, tabColorStyle, gridProperties}, fields}; fields defaults to the properties you set.',
  inputSchema: schema(
    { spreadsheetId: SPREADSHEET_ID, updateSheetProperties: anyObj('{"properties": {"sheetId": 0, "title": "Q3"}, "fields": "title"}.'), ...RESPONSE_PROPS_CAMEL },
    ['spreadsheetId', 'updateSheetProperties'],
  ),
  annotations: IDEMPOTENT,
  async run(args, ctx) {
    const id = sid(args, 'spreadsheetId', 'spreadsheet_id');
    const request = objArg(args, 'updateSheetProperties', 'update_sheet_properties') ?? {};
    const properties = request.properties && typeof request.properties === 'object' ? (request.properties as Json) : undefined;
    if (!properties) throw new ToolInputError('updateSheetProperties.properties is required');
    if (int(properties, 'sheetId', 'sheet_id') === undefined) throw new ToolInputError('updateSheetProperties.properties.sheetId is required');
    const fields = typeof request.fields === 'string' && request.fields.trim() && request.fields !== '*' ? request.fields : fieldMask(properties, ['sheetId', 'sheet_id']);
    if (!fields) throw new ToolInputError('Set at least one property besides sheetId');
    return batchTool(ctx, id, [{ updateSheetProperties: { properties, fields } }], args, int(properties, 'sheetId', 'sheet_id'));
  },
};

const updateSpreadsheetProperties: GoogleTool = {
  name: 'update_spreadsheet_properties',
  title: 'Update spreadsheet properties',
  description: 'Change spreadsheet-wide settings: title, locale, timeZone, autoRecalc, defaultFormat. Use update_sheet_properties for one sheet.',
  inputSchema: schema(
    {
      spreadsheetId: SPREADSHEET_ID,
      properties: anyObj('SpreadsheetProperties to set, such as {"title": "Budget 2026", "timeZone": "Europe/Berlin"}.'),
      fields: s('Field mask, such as title,timeZone. `*` or empty: the properties you set.'),
      ...RESPONSE_PROPS_CAMEL,
    },
    ['spreadsheetId', 'properties', 'fields'],
  ),
  annotations: IDEMPOTENT,
  async run(args, ctx) {
    const id = sid(args, 'spreadsheetId', 'spreadsheet_id');
    const properties = objArg(args, 'properties');
    if (!properties || !Object.keys(properties).length) throw new ToolInputError('properties must set at least one field');
    const given = str(args, 'fields');
    const fields = given && given !== '*' ? given.replace(/(^|,)\s*properties\./g, '$1') : fieldMask(properties);
    const result = await batchTool(ctx, id, [{ updateSpreadsheetProperties: { properties, fields } }], args);
    return given && given !== fields ? { ...result, composio_execution_message: `Kortix used the field mask "${fields}".` } : result;
  },
};

const sheetsCopyTo: GoogleTool = {
  name: 'spreadsheets_sheets_copy_to',
  title: 'Copy sheet to spreadsheet',
  description: 'Copy one sheet, with its data and formatting, into another spreadsheet. Returns the new sheet\'s properties.',
  inputSchema: schema(
    { spreadsheet_id: SPREADSHEET_ID, sheet_id: i('Numeric id of the sheet to copy.'), destination_spreadsheet_id: s('Id of the spreadsheet to copy into.') },
    ['spreadsheet_id', 'sheet_id', 'destination_spreadsheet_id'],
  ),
  annotations: WRITE,
  async run(args, ctx) {
    const id = sid(args);
    const destination = sid(args, 'destination_spreadsheet_id', 'destinationSpreadsheetId');
    const result = await ctx.google.json<SheetProps>({
      method: 'POST',
      url: `${S}/${enc(id)}/sheets/${reqInt(args, 'sheet_id', 'sheetId')}:copyTo`,
      body: { destinationSpreadsheetId: destination },
    });
    return { ...result, display_url: sheetUrl(destination, result?.sheetId) };
  },
};

const searchDeveloperMetadata: GoogleTool = {
  name: 'search_developer_metadata',
  title: 'Search developer metadata',
  description: 'Find developer metadata entries that match data filters, such as {"developerMetadataLookup": {"metadataKey": "x"}}.',
  inputSchema: schema({ spreadsheetId: SPREADSHEET_ID, dataFilters: DATA_FILTERS }, ['spreadsheetId', 'dataFilters']),
  annotations: READ,
  async run(args, ctx) {
    const id = sid(args, 'spreadsheetId', 'spreadsheet_id');
    const result = await ctx.google.json<Json>({ method: 'POST', url: `${S}/${enc(id)}/developerMetadata:search`, body: { dataFilters: dataFilters(args, true) } });
    return { matchedDeveloperMetadata: [], ...result, display_url: sheetUrl(id) };
  },
};

// ─── Rows and columns ───────────────────────────────────────────────────────

const appendDimension: GoogleTool = {
  name: 'append_dimension',
  title: 'Add rows or columns at the end',
  description: 'Add empty rows or columns at the end of a sheet.',
  inputSchema: schema(
    { spreadsheet_id: SPREADSHEET_ID, sheet_id: i('Numeric sheet id (gid).'), dimension: s('ROWS or COLUMNS.', { enum: [...DIMENSIONS] }), length: i('How many to add.'), ...RESPONSE_PROPS },
    ['spreadsheet_id', 'sheet_id', 'dimension', 'length'],
  ),
  annotations: WRITE,
  run(args, ctx) {
    const id = sid(args);
    const sheetId = reqInt(args, 'sheet_id', 'sheetId');
    const length = reqInt(args, 'length');
    if (length < 1) throw new ToolInputError('length must be at least 1');
    return batchTool(ctx, id, [{ appendDimension: { sheetId, dimension: enumArg(args, DIMENSIONS, undefined, 'dimension'), length } }], args, sheetId);
  },
};

function dimensionRange(value: unknown): Json {
  const o = value && typeof value === 'object' ? (value as Json) : {};
  const sheetId = int(o, 'sheet_id', 'sheetId');
  const start = int(o, 'start_index', 'startIndex');
  const end = int(o, 'end_index', 'endIndex');
  const dimension = enumArg(o, DIMENSIONS, undefined, 'dimension');
  if (sheetId === undefined || start === undefined || end === undefined || !dimension) throw new ToolInputError('range needs sheet_id, dimension, start_index and end_index');
  if (end <= start) throw new ToolInputError('end_index must be greater than start_index');
  return { sheetId, dimension, startIndex: start, endIndex: end };
}

const insertDimension: GoogleTool = {
  name: 'insert_dimension',
  title: 'Insert rows or columns',
  description: 'Insert empty rows or columns at a position. insert_dimension is {range: {sheet_id, dimension, start_index, end_index}, inherit_from_before}.',
  inputSchema: schema(
    {
      spreadsheet_id: SPREADSHEET_ID,
      insert_dimension: anyObj('{"range": {"sheet_id": 0, "dimension": "ROWS", "start_index": 5, "end_index": 8}, "inherit_from_before": true} inserts rows 6–8.'),
      ...RESPONSE_PROPS,
    },
    ['spreadsheet_id', 'insert_dimension'],
  ),
  annotations: WRITE,
  run(args, ctx) {
    const id = sid(args);
    const request = objArg(args, 'insert_dimension', 'insertDimension');
    if (!request) throw new ToolInputError('insert_dimension is required');
    const range = dimensionRange(request.range);
    const inherit = flag(request, 'inherit_from_before', 'inheritFromBefore');
    return batchTool(ctx, id, [{ insertDimension: { range, ...(inherit !== undefined ? { inheritFromBefore: inherit && (range.startIndex as number) > 0 } : {}) } }], args, range.sheetId as number);
  },
};

const deleteDimension: GoogleTool = {
  name: 'delete_dimension',
  title: 'Delete rows or columns',
  description: 'Delete rows or columns, by zero-based start_index (inclusive) and end_index (exclusive). At least one row and one column must remain.',
  inputSchema: schema(
    {
      spreadsheet_id: SPREADSHEET_ID,
      sheet_id: i('Numeric sheet id. Or sheet_name.'),
      sheet_name: s('Sheet name. Or sheet_id.'),
      dimension: s('ROWS or COLUMNS.', { enum: [...DIMENSIONS] }),
      start_index: i('First row/column to delete, zero-based, inclusive.'),
      end_index: i('Last row/column, zero-based, exclusive.'),
      delete_dimension_request: anyObj('Alternative form: {"range": {"sheet_id", "dimension", "start_index", "end_index"}}.'),
      ...RESPONSE_PROPS,
    },
    ['spreadsheet_id'],
  ),
  annotations: DESTRUCTIVE,
  async run(args, ctx) {
    const id = sid(args);
    const nested = objArg(args, 'delete_dimension_request', 'deleteDimensionRequest');
    let range: Json;
    if (nested?.range) {
      range = dimensionRange(nested.range);
    } else {
      const sheetId = await sheetIdArg(ctx, id, args, { namePrecedence: false });
      range = dimensionRange({ sheet_id: sheetId, dimension: args.dimension, start_index: args.start_index ?? args.startIndex, end_index: args.end_index ?? args.endIndex });
    }
    return batchTool(ctx, id, [{ deleteDimension: { range } }], args, range.sheetId as number);
  },
};

function insertOne(name: string, dimension: 'ROWS' | 'COLUMNS'): GoogleTool {
  const noun = dimension === 'ROWS' ? 'row' : 'column';
  return {
    name,
    title: `Insert ${noun}`,
    description: `Insert one empty ${noun} at insert_index (zero-based). The sheet is sheet_id, else sheet_name, else sheet id 0.`,
    inputSchema: schema(
      {
        spreadsheet_id: SPREADSHEET_ID,
        sheet_id: i('Numeric sheet id. Wins over sheet_name.'),
        sheet_name: s('Sheet name.'),
        insert_index: i(`Zero-based position of the new ${noun}.`, { default: 0 }),
        inherit_from_before: b(`Copy the format of the ${noun} before (false: the ${noun} after).`, { default: false }),
        ...RESPONSE_PROPS,
      },
      ['spreadsheet_id'],
    ),
    annotations: WRITE,
    async run(args, ctx) {
      const id = sid(args);
      const sheetId = await sheetIdArg(ctx, id, args, { namePrecedence: false, fallback: 0 });
      const index = int(args, 'insert_index', 'insertIndex') ?? 0;
      if (index < 0) throw new ToolInputError('insert_index must be 0 or more');
      const inherit = (flag(args, 'inherit_from_before', 'inheritFromBefore') ?? false) && index > 0;
      return batchTool(ctx, id, [{ insertDimension: { range: { sheetId, dimension, startIndex: index, endIndex: index + 1 }, inheritFromBefore: inherit } }], args, sheetId);
    },
  };
}

const autoResizeDimensions: GoogleTool = {
  name: 'auto_resize_dimensions',
  title: 'Auto-fit rows or columns',
  description: 'Fit column widths or row heights to their content. start_index and end_index are zero-based; A–C is 0 to 3.',
  inputSchema: schema(
    {
      spreadsheet_id: SPREADSHEET_ID,
      sheet_id: i('Numeric sheet id. Or sheet_name.'),
      sheet_name: s('Sheet name. Wins over sheet_id.'),
      dimension: s('ROWS or COLUMNS.', { enum: [...DIMENSIONS] }),
      start_index: i('Zero-based start, inclusive.'),
      end_index: i('Zero-based end, exclusive.'),
    },
    ['spreadsheet_id', 'dimension', 'start_index', 'end_index'],
  ),
  annotations: IDEMPOTENT,
  async run(args, ctx) {
    const id = sid(args);
    const sheetId = await sheetIdArg(ctx, id, args, { namePrecedence: true });
    const range = dimensionRange({ sheet_id: sheetId, dimension: args.dimension, start_index: args.start_index ?? args.startIndex, end_index: args.end_index ?? args.endIndex });
    const result = await batchUpdate(ctx, id, [{ autoResizeDimensions: { dimensions: range } }]);
    return { ...result, display_url: sheetUrl(id, sheetId) };
  },
};

const updateDimensionProperties: GoogleTool = {
  name: 'update_dimension_properties',
  title: 'Resize or hide rows or columns',
  description: 'Set the pixel height of rows or width of columns, or hide and unhide them. Indexes are zero-based, end exclusive.',
  inputSchema: schema(
    {
      spreadsheet_id: SPREADSHEET_ID,
      sheet_id: i('Numeric sheet id. Or sheet_name.'),
      sheet_name: s('Sheet name. Wins over sheet_id.'),
      dimension: s('ROWS or COLUMNS.', { enum: [...DIMENSIONS] }),
      start_index: i('Zero-based start, inclusive.'),
      end_index: i('Zero-based end, exclusive.'),
      pixel_size: i('Row height or column width in pixels.'),
      hidden_by_user: b('True hides, false unhides.'),
      ...RESPONSE_PROPS,
    },
    ['spreadsheet_id', 'dimension', 'start_index', 'end_index'],
  ),
  annotations: IDEMPOTENT,
  async run(args, ctx) {
    const id = sid(args);
    const sheetId = await sheetIdArg(ctx, id, args, { namePrecedence: true });
    const range = dimensionRange({ sheet_id: sheetId, dimension: args.dimension, start_index: args.start_index ?? args.startIndex, end_index: args.end_index ?? args.endIndex });
    const pixelSize = int(args, 'pixel_size', 'pixelSize');
    const hidden = flag(args, 'hidden_by_user', 'hiddenByUser');
    if (pixelSize === undefined && hidden === undefined) throw new ToolInputError('pixel_size or hidden_by_user is required');
    if (pixelSize !== undefined && pixelSize < 1) throw new ToolInputError('pixel_size must be a positive integer');
    const properties = { ...(pixelSize !== undefined ? { pixelSize } : {}), ...(hidden !== undefined ? { hiddenByUser: hidden } : {}) };
    return batchTool(ctx, id, [{ updateDimensionProperties: { range, properties, fields: Object.keys(properties).join(',') } }], args, sheetId);
  },
};

// ─── Formatting, find/replace, sort, filters ────────────────────────────────

function hexColor(hex: string | undefined, name: string): Json | undefined {
  if (hex === undefined) return undefined;
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) throw new ToolInputError(`${name} must be a 6-digit hex color, such as #1A73E8`);
  const value = parseInt(match[1]!, 16);
  return { red: ((value >> 16) & 255) / 255, green: ((value >> 8) & 255) / 255, blue: (value & 255) / 255 };
}

/** The sheet format_cell targets: sheet_name, else worksheet_id (sheetId, then position), else the range's sheet prefix. */
async function formatTarget(ctx: ToolContext, spreadsheetId: string, args: Json): Promise<{ sheet: SheetProps; box: Box }> {
  const range = str(args, 'range');
  const split = range ? splitA1(range) : { cells: '' };
  const sheets = await sheetsOf(ctx, spreadsheetId);
  const name = str(args, 'sheet_name', 'sheetName') ?? (args.worksheet_id === undefined && args.worksheetId === undefined ? split.sheet : undefined);
  let sheet: SheetProps | undefined;
  if (name !== undefined) {
    sheet = findSheet(sheets, name);
    if (!sheet) throw noSheet(name, sheets);
  } else {
    const ref = int(args, 'worksheet_id', 'worksheetId') ?? 0;
    sheet = sheets.find((candidate) => candidate.sheetId === ref) ?? sheets[ref];
    if (!sheet) throw new ToolInputError(`No sheet has sheetId or position ${ref}`);
  }
  if (range) {
    const box = parseBox(split.cells);
    if (!box) throw new ToolInputError(`range "${range}" is not A1 notation (A1, A1:B5, A:C or 1:5)`);
    return { sheet, box };
  }
  const box = {
    startRow: int(args, 'start_row_index', 'startRowIndex'),
    endRow: int(args, 'end_row_index', 'endRowIndex'),
    startCol: int(args, 'start_column_index', 'startColumnIndex'),
    endCol: int(args, 'end_column_index', 'endColumnIndex'),
  };
  if (Object.values(box).some((v) => v === undefined)) throw new ToolInputError('Pass range, or all four of start_row_index, end_row_index, start_column_index and end_column_index');
  return { sheet, box };
}

/** The userEnteredFormat and field list of format_cell. */
function cellFormat(args: Json): { format: Json; fields: string[] } {
  const text: Json = {
    bold: flag(args, 'bold') ?? false,
    italic: flag(args, 'italic') ?? false,
    underline: flag(args, 'underline') ?? false,
    strikethrough: flag(args, 'strikethrough') ?? false,
    fontSize: int(args, 'fontSize', 'font_size') ?? 10,
  };
  const fields = ['textFormat.bold', 'textFormat.italic', 'textFormat.underline', 'textFormat.strikethrough', 'textFormat.fontSize'];
  const put = (target: Json, key: string, value: unknown, field: string) => {
    target[key] = value;
    fields.push(field);
  };
  const family = str(args, 'font_family', 'fontFamily');
  if (family) put(text, 'fontFamily', family, 'textFormat.fontFamily');
  const color = hexColor(str(args, 'text_color', 'textColor'), 'text_color');
  if (color) put(text, 'foregroundColorStyle', { rgbColor: color }, 'textFormat.foregroundColorStyle');
  const link = str(args, 'text_link', 'textLink');
  if (link) put(text, 'link', { uri: link }, 'textFormat.link');
  const background: Json = hexColor(str(args, 'background_color', 'backgroundColor'), 'background_color') ?? {
    red: num(args, 'red') ?? 0.9,
    green: num(args, 'green') ?? 0.9,
    blue: num(args, 'blue') ?? 0.9,
  };
  const alpha = num(args, 'background_alpha', 'backgroundAlpha');
  if (alpha !== undefined) background.alpha = alpha;
  const format: Json = { textFormat: text, backgroundColorStyle: { rgbColor: background } };
  fields.push('backgroundColorStyle');
  const padding = { top: int(args, 'padding_top'), right: int(args, 'padding_right'), bottom: int(args, 'padding_bottom'), left: int(args, 'padding_left') };
  if (Object.values(padding).some((v) => v !== undefined)) put(format, 'padding', padding, 'padding');
  const simple: Array<[string, string, readonly string[]]> = [
    ['wrap_strategy', 'wrapStrategy', ['OVERFLOW_CELL', 'LEGACY_WRAP', 'CLIP', 'WRAP']],
    ['text_direction', 'textDirection', ['LEFT_TO_RIGHT', 'RIGHT_TO_LEFT']],
    ['vertical_alignment', 'verticalAlignment', ['TOP', 'MIDDLE', 'BOTTOM']],
    ['horizontal_alignment', 'horizontalAlignment', ['LEFT', 'CENTER', 'RIGHT']],
    ['hyperlink_display_type', 'hyperlinkDisplayType', ['LINKED', 'PLAIN_TEXT']],
  ];
  for (const [snake, camel, allowed] of simple) {
    const value = enumArg(args, allowed, undefined, snake, camel);
    if (value) put(format, camel, value, camel);
  }
  const angle = int(args, 'text_rotation_angle', 'textRotationAngle');
  const vertical = flag(args, 'text_rotation_vertical', 'textRotationVertical');
  if (vertical !== undefined || angle !== undefined) put(format, 'textRotation', vertical ? { vertical: true } : { angle: angle ?? 0 }, 'textRotation');
  const numberType = enumArg(args, ['TEXT', 'NUMBER', 'PERCENT', 'CURRENCY', 'DATE', 'TIME', 'DATE_TIME', 'SCIENTIFIC'], undefined, 'number_format_type', 'numberFormatType');
  const pattern = str(args, 'number_format_pattern', 'numberFormatPattern');
  if (numberType || pattern) put(format, 'numberFormat', { type: numberType ?? 'NUMBER', ...(pattern ? { pattern } : {}) }, 'numberFormat');
  return { format, fields };
}

const formatCell: GoogleTool = {
  name: 'format_cell',
  title: 'Format cells',
  description:
    'Format a range: bold, italic, underline, font, size, colors, borders, alignment, wrap, rotation, number format. Bold, italic, underline, strikethrough, font size 10 and a light gray background (red/green/blue 0.9) apply unless you set them. The sheet is sheet_name, else worksheet_id, else the range\'s sheet prefix.',
  inputSchema: schema(
    {
      spreadsheet_id: SPREADSHEET_ID,
      range: s('A1 range: A1, A1:B5, A, I:J, 1 or 1:5. Or pass the four index fields.'),
      sheet_name: s('Sheet name. Wins over worksheet_id.'),
      worksheet_id: i('sheetId, or the zero-based sheet position.', { default: 0 }),
      start_row_index: i('Zero-based first row, inclusive.'),
      end_row_index: i('Zero-based last row, exclusive.'),
      start_column_index: i('Zero-based first column, inclusive.'),
      end_column_index: i('Zero-based last column, exclusive.'),
      bold: b('Bold.', { default: false }),
      italic: b('Italic.', { default: false }),
      underline: b('Underline.', { default: false }),
      strikethrough: b('Strikethrough.', { default: false }),
      fontSize: i('Font size in points.', { default: 10 }),
      font_family: s('Font family, such as Roboto.'),
      text_color: s('Text color, 6-digit hex.'),
      text_link: s('Link for the cell text, such as https://example.com.'),
      red: n('Background red, 0–1.', { default: 0.9 }),
      green: n('Background green, 0–1.', { default: 0.9 }),
      blue: n('Background blue, 0–1.', { default: 0.9 }),
      background_color: s('Background color, 6-digit hex. Wins over red/green/blue.'),
      background_alpha: n('Background alpha, 0–1.'),
      border_style: s('Border on every edge of every cell.', { enum: ['DOTTED', 'DASHED', 'SOLID', 'SOLID_MEDIUM', 'SOLID_THICK', 'NONE', 'DOUBLE'] }),
      border_color: s('Border color, 6-digit hex.'),
      padding_top: i('Top padding, pixels.'),
      padding_right: i('Right padding, pixels.'),
      padding_bottom: i('Bottom padding, pixels.'),
      padding_left: i('Left padding, pixels.'),
      wrap_strategy: s('Text wrapping.', { enum: ['OVERFLOW_CELL', 'LEGACY_WRAP', 'CLIP', 'WRAP'] }),
      text_direction: s('Text direction.', { enum: ['LEFT_TO_RIGHT', 'RIGHT_TO_LEFT'] }),
      vertical_alignment: s('Vertical alignment.', { enum: ['TOP', 'MIDDLE', 'BOTTOM'] }),
      horizontal_alignment: s('Horizontal alignment.', { enum: ['LEFT', 'CENTER', 'RIGHT'] }),
      text_rotation_angle: i('Rotation, -90 to 90 degrees.'),
      text_rotation_vertical: b('Stack the text vertically.'),
      number_format_type: s('Number format type.', { enum: ['TEXT', 'NUMBER', 'PERCENT', 'CURRENCY', 'DATE', 'TIME', 'DATE_TIME', 'SCIENTIFIC'] }),
      number_format_pattern: s('Number or date pattern, such as #,##0.00 or yyyy-mm-dd.'),
      hyperlink_display_type: s('How links display.', { enum: ['LINKED', 'PLAIN_TEXT'] }),
    },
    ['spreadsheet_id'],
  ),
  annotations: IDEMPOTENT,
  async run(args, ctx) {
    const id = sid(args);
    const { sheet, box } = await formatTarget(ctx, id, args);
    const range = gridRange(sheet.sheetId, box);
    const { format, fields } = cellFormat(args);
    const requests: Json[] = [{ repeatCell: { range, cell: { userEnteredFormat: format }, fields: fields.map((f) => `userEnteredFormat.${f}`).join(',') } }];
    const borderStyle = enumArg(args, ['DOTTED', 'DASHED', 'SOLID', 'SOLID_MEDIUM', 'SOLID_THICK', 'NONE', 'DOUBLE'], undefined, 'border_style', 'borderStyle');
    if (borderStyle) {
      const border = { style: borderStyle, colorStyle: { rgbColor: hexColor(str(args, 'border_color', 'borderColor'), 'border_color') ?? { red: 0, green: 0, blue: 0 } } };
      requests.push({ updateBorders: { range, top: border, bottom: border, left: border, right: border, innerHorizontal: border, innerVertical: border } });
    }
    const result = await batchUpdate(ctx, id, requests);
    return { ...result, display_url: sheetUrl(id, sheet.sheetId) };
  },
};

const findReplace: GoogleTool = {
  name: 'find_replace',
  title: 'Find and replace',
  description:
    'Find and replace text in cells. Scope: sheetId, sheetName, range (A1, its sheet resolved by name), rangeSheetId with indexes, or allSheets. With no scope, every sheet.',
  inputSchema: schema(
    {
      spreadsheetId: SPREADSHEET_ID,
      find: s('Text or regular expression to find.'),
      replace: s('Replacement text.'),
      sheetId: i('Search one whole sheet by id.'),
      sheetName: s('Search one whole sheet by name.'),
      range: s('A1 range to search, such as Sheet1!A1:B10.'),
      rangeSheetId: i('Sheet id of range or of the index fields.'),
      startRowIndex: i('Zero-based first row, with rangeSheetId.'),
      endRowIndex: i('Zero-based last row, exclusive.'),
      startColumnIndex: i('Zero-based first column.'),
      endColumnIndex: i('Zero-based last column, exclusive.'),
      allSheets: b('Search every sheet.', { default: false }),
      matchCase: b('Case-sensitive.', { default: false }),
      matchEntireCell: b('Match whole cell contents only.', { default: false }),
      searchByRegex: b('find is a regular expression.', { default: false }),
      includeFormulas: b('Also search formula text.'),
    },
    ['spreadsheetId', 'find', 'replace'],
  ),
  annotations: WRITE,
  async run(args, ctx) {
    const id = sid(args, 'spreadsheetId', 'spreadsheet_id');
    const find = reqStr(args, 'find');
    const replacement = typeof args.replace === 'string' ? args.replace : typeof args.replacement === 'string' ? args.replacement : undefined;
    if (replacement === undefined) throw new ToolInputError('replace is required');
    const request: Json = {
      find,
      replacement,
      matchCase: flag(args, 'matchCase', 'match_case') ?? false,
      matchEntireCell: flag(args, 'matchEntireCell', 'match_entire_cell') ?? false,
      searchByRegex: flag(args, 'searchByRegex', 'search_by_regex') ?? false,
      ...(flag(args, 'includeFormulas', 'include_formulas') !== undefined ? { includeFormulas: flag(args, 'includeFormulas', 'include_formulas') } : {}),
    };
    const range = str(args, 'range');
    const rangeSheetId = int(args, 'rangeSheetId', 'range_sheet_id');
    const sheetName = str(args, 'sheetName', 'sheet_name');
    const sheetId = int(args, 'sheetId', 'sheet_id');
    let scope = 'all sheets';
    if (range) {
      const split = splitA1(range);
      const box = parseBox(split.cells);
      if (!box) throw new ToolInputError(`range "${range}" is not A1 notation`);
      const target = rangeSheetId ?? (await pickSheet(ctx, id, { name: split.sheet ?? sheetName, id: sheetId, firstSheet: true })).sheet.sheetId;
      request.range = gridRange(target, box);
      scope = `range ${range}`;
    } else if (rangeSheetId !== undefined) {
      request.range = gridFrom(args, rangeSheetId);
      (request.range as Json).sheetId = rangeSheetId;
      scope = `a range of sheet ${rangeSheetId}`;
    } else if (sheetName !== undefined || sheetId !== undefined) {
      request.sheetId = sheetName !== undefined ? (await pickSheet(ctx, id, { name: sheetName })).sheet.sheetId : sheetId;
      scope = `sheet ${sheetName ?? sheetId}`;
    } else {
      request.allSheets = true;
    }
    const result = await batchUpdate(ctx, id, [{ findReplace: request }]);
    const reply = ((result.replies as Array<{ findReplace?: Json }> | undefined)?.[0]?.findReplace ?? {}) as Json;
    return {
      spreadsheetId: id,
      occurrencesChanged: reply.occurrencesChanged ?? 0,
      valuesChanged: reply.valuesChanged ?? 0,
      formulasChanged: reply.formulasChanged ?? 0,
      rowsChanged: reply.rowsChanged ?? 0,
      sheetsChanged: reply.sheetsChanged ?? 0,
      display_url: sheetUrl(id),
      composio_execution_message: `Searched ${scope}.`,
    };
  },
};

const sortRange: GoogleTool = {
  name: 'sort_range',
  title: 'Sort a range',
  description: 'Sort the rows of a range by one or more columns. sortSpecs: [{"dimensionIndex": 1, "sortOrder": "DESCENDING"}]; dimensionIndex is the zero-based sheet column.',
  inputSchema: schema(
    {
      spreadsheet_id: SPREADSHEET_ID,
      range: anyObj('GridRange: {"sheet_id": 0, "start_row_index": 1, "end_row_index": 100, "start_column_index": 0, "end_column_index": 5}.'),
      sortSpecs: arr({ type: 'object', additionalProperties: true }, 'Sort keys in priority order: {dimensionIndex, sortOrder: ASCENDING | DESCENDING}.'),
      ...RESPONSE_PROPS_CAMEL,
    },
    ['spreadsheet_id', 'range', 'sortSpecs'],
  ),
  annotations: WRITE,
  run(args, ctx) {
    const id = sid(args);
    const range = gridFrom(objArg(args, 'range'));
    const specs = (listArg(args, 'sortSpecs', 'sort_specs') ?? []).map((spec) => {
      const o = (spec ?? {}) as Json;
      return { ...o, dimensionIndex: int(o, 'dimensionIndex', 'dimension_index'), sortOrder: enumArg(o, ['ASCENDING', 'DESCENDING', 'SORT_ORDER_UNSPECIFIED'], 'ASCENDING', 'sortOrder', 'sort_order') };
    });
    if (!specs.length) throw new ToolInputError('sortSpecs needs at least one sort key');
    return batchTool(ctx, id, [{ sortRange: { range, sortSpecs: specs } }], args, range.sheetId as number);
  },
};

const setBasicFilter: GoogleTool = {
  name: 'set_basic_filter',
  title: 'Set filter',
  description: 'Set the basic filter of a sheet: its range, sort and per-column filter criteria. filter.range is a GridRange with sheet_id.',
  inputSchema: schema(
    { spreadsheetId: SPREADSHEET_ID, filter: anyObj('BasicFilter: {"range": {"sheet_id": 0, ...}, "sortSpecs": [...], "filterSpecs": [...]}.'), ...RESPONSE_PROPS_CAMEL },
    ['spreadsheetId', 'filter'],
  ),
  annotations: WRITE,
  run(args, ctx) {
    const id = sid(args, 'spreadsheetId', 'spreadsheet_id');
    const filter = objArg(args, 'filter');
    if (!filter) throw new ToolInputError('filter is required');
    const out: Json = { ...filter };
    if (filter.range) out.range = gridFrom(filter.range);
    return batchTool(ctx, id, [{ setBasicFilter: { filter: out } }], args, (out.range as Json | undefined)?.sheetId as number | undefined);
  },
};

const clearBasicFilter: GoogleTool = {
  name: 'clear_basic_filter',
  title: 'Clear filter',
  description: 'Remove the basic filter of a sheet. The data stays.',
  inputSchema: schema({ spreadsheet_id: SPREADSHEET_ID, sheet_id: i('Numeric sheet id.'), ...RESPONSE_PROPS }, ['spreadsheet_id', 'sheet_id']),
  annotations: WRITE,
  run(args, ctx) {
    const id = sid(args);
    const sheetId = reqInt(args, 'sheet_id', 'sheetId');
    return batchTool(ctx, id, [{ clearBasicFilter: { sheetId } }], args, sheetId);
  },
};

const VALIDATION_TYPES = [
  'ONE_OF_LIST', 'ONE_OF_RANGE', 'CUSTOM_FORMULA', 'NUMBER_GREATER', 'NUMBER_GREATER_THAN_EQ', 'NUMBER_LESS', 'NUMBER_LESS_THAN_EQ', 'NUMBER_EQ',
  'NUMBER_NOT_EQ', 'NUMBER_BETWEEN', 'NUMBER_NOT_BETWEEN', 'TEXT_CONTAINS', 'TEXT_NOT_CONTAINS', 'TEXT_EQ', 'TEXT_NOT_EQ', 'TEXT_IS_EMAIL', 'TEXT_IS_URL',
  'DATE_EQ', 'DATE_BEFORE', 'DATE_AFTER', 'DATE_ON_OR_BEFORE', 'DATE_ON_OR_AFTER', 'DATE_BETWEEN', 'DATE_NOT_BETWEEN', 'DATE_NOT_EQ', 'DATE_IS_VALID',
  'BLANK', 'NOT_BLANK', 'BOOLEAN',
] as const;

function validationCondition(args: Json, type: string): Json {
  const values = (list: string[]) => list.map((value) => ({ userEnteredValue: value }));
  if (type === 'ONE_OF_LIST') {
    const options = strList(args, 'values');
    if (!options.length) throw new ToolInputError('values is required for ONE_OF_LIST');
    return { type, values: values(options) };
  }
  if (type === 'ONE_OF_RANGE') {
    const source = str(args, 'source_range_a1', 'sourceRangeA1');
    if (!source) throw new ToolInputError('source_range_a1 is required for ONE_OF_RANGE');
    return { type, values: values([`=${fixRange(source.replace(/^=/, ''))}`]) };
  }
  if (type === 'CUSTOM_FORMULA') {
    const formula = str(args, 'formula');
    if (!formula) throw new ToolInputError('formula is required for CUSTOM_FORMULA');
    return { type, values: values([formula.startsWith('=') ? formula : `=${formula}`]) };
  }
  const conditionValues = strList(args, 'condition_values', 'conditionValues');
  return conditionValues.length ? { type, values: values(conditionValues) } : { type };
}

const setDataValidationRule: GoogleTool = {
  name: 'set_data_validation_rule',
  title: 'Set data validation',
  description:
    'Set or clear data validation on a range: dropdowns (ONE_OF_LIST with values, ONE_OF_RANGE with source_range_a1), CUSTOM_FORMULA, number, text and date checks (condition_values). Indexes are zero-based, end exclusive.',
  inputSchema: schema(
    {
      spreadsheet_id: SPREADSHEET_ID,
      sheet_id: i('Numeric sheet id.'),
      mode: s('SET applies a rule; CLEAR removes validation from the range.', { enum: ['SET', 'CLEAR'] }),
      start_row_index: i('Zero-based first row.'),
      end_row_index: i('Zero-based last row, exclusive.'),
      start_column_index: i('Zero-based first column.'),
      end_column_index: i('Zero-based last column, exclusive.'),
      validation_type: s('Rule type. Required with SET.', { enum: [...VALIDATION_TYPES] }),
      values: strs('Dropdown options for ONE_OF_LIST.'),
      source_range_a1: s('Range holding the options for ONE_OF_RANGE, such as Lists!A1:A10.'),
      formula: s('Formula for CUSTOM_FORMULA, such as =A1>10.'),
      condition_values: strs('Values for the other types: one for NUMBER_GREATER, two for NUMBER_BETWEEN.'),
      strict: b('Reject invalid input (false: warn).', { default: true }),
      show_custom_ui: b('Show the dropdown arrow for list rules.', { default: true }),
      input_message: s('Help text shown when the cell is selected.'),
      filtered_rows_included: b('Also apply to rows a filter hides.', { default: false }),
    },
    ['spreadsheet_id', 'sheet_id', 'mode', 'start_row_index', 'end_row_index', 'start_column_index', 'end_column_index'],
  ),
  annotations: WRITE,
  async run(args, ctx) {
    const id = sid(args);
    const sheetId = reqInt(args, 'sheet_id', 'sheetId');
    const range = {
      sheetId,
      startRowIndex: reqInt(args, 'start_row_index', 'startRowIndex'),
      endRowIndex: reqInt(args, 'end_row_index', 'endRowIndex'),
      startColumnIndex: reqInt(args, 'start_column_index', 'startColumnIndex'),
      endColumnIndex: reqInt(args, 'end_column_index', 'endColumnIndex'),
    };
    const mode = enumArg(args, ['SET', 'CLEAR'], undefined, 'mode');
    if (!mode) throw new ToolInputError('mode is required');
    const request: Json = { range, filteredRowsIncluded: flag(args, 'filtered_rows_included', 'filteredRowsIncluded') ?? false };
    let summary = `Cleared data validation from ${indexToCol(range.startColumnIndex)}${range.startRowIndex + 1}:${indexToCol(range.endColumnIndex - 1)}${range.endRowIndex}.`;
    if (mode === 'SET') {
      const type = enumArg(args, VALIDATION_TYPES, undefined, 'validation_type', 'validationType');
      if (!type) throw new ToolInputError('validation_type is required when mode is SET');
      const inputMessage = str(args, 'input_message', 'inputMessage');
      request.rule = {
        condition: validationCondition(args, type),
        strict: flag(args, 'strict') ?? true,
        showCustomUi: flag(args, 'show_custom_ui', 'showCustomUi') ?? true,
        ...(inputMessage ? { inputMessage } : {}),
      };
      summary = `Set ${type} validation on ${indexToCol(range.startColumnIndex)}${range.startRowIndex + 1}:${indexToCol(range.endColumnIndex - 1)}${range.endRowIndex}.`;
    }
    const result = await batchUpdate(ctx, id, [{ setDataValidation: request }]);
    return { ...result, summary, display_url: sheetUrl(id, sheetId) };
  },
};

interface GridSheet {
  properties: SheetProps;
  data?: Array<{ startRow?: number; startColumn?: number; rowData?: Array<{ values?: Array<{ dataValidation?: Json }> }> }>;
  conditionalFormats?: Json[];
}

function ruleKind(type: string | undefined): string {
  if (type === 'ONE_OF_LIST') return 'DROPDOWN_LIST';
  if (type === 'ONE_OF_RANGE') return 'DROPDOWN_RANGE';
  if (type === 'BOOLEAN') return 'CHECKBOX';
  return type ?? 'NONE';
}

/** Merge cells with equal rules into rectangles: runs per row, then runs of equal rows. */
function validationRanges(sheet: GridSheet, includeEmpty: boolean): Json[] {
  const out: Json[] = [];
  for (const block of sheet.data ?? []) {
    const runs = new Map<string, { rule?: Json; startRow: number; endRow: number; startCol: number; endCol: number }>();
    const done: Array<{ rule?: Json; startRow: number; endRow: number; startCol: number; endCol: number }> = [];
    (block.rowData ?? []).forEach((row, r) => {
      const rowIndex = (block.startRow ?? 0) + r;
      const segments: Array<{ key: string; rule?: Json; start: number; end: number }> = [];
      (row.values ?? []).forEach((cell, c) => {
        const col = (block.startColumn ?? 0) + c;
        const key = cell.dataValidation ? JSON.stringify(cell.dataValidation) : '';
        if (!key && !includeEmpty) return;
        const last = segments[segments.length - 1];
        if (last && last.key === key && last.end === col) last.end = col + 1;
        else segments.push({ key, rule: cell.dataValidation, start: col, end: col + 1 });
      });
      const seen = new Set<string>();
      for (const segment of segments) {
        const id = `${segment.key}|${segment.start}|${segment.end}`;
        seen.add(id);
        const open = runs.get(id);
        if (open && open.endRow === rowIndex) open.endRow = rowIndex + 1;
        else {
          if (open) done.push(open);
          runs.set(id, { rule: segment.rule, startRow: rowIndex, endRow: rowIndex + 1, startCol: segment.start, endCol: segment.end });
        }
      }
      for (const [id, open] of runs) {
        if (seen.has(id) || open.endRow > rowIndex) continue;
        done.push(open);
        runs.delete(id);
      }
    });
    done.push(...runs.values());
    for (const run of done) {
      const condition = (run.rule?.condition ?? {}) as { type?: string; values?: Array<{ userEnteredValue?: string }> };
      out.push({
        sheetId: sheet.properties.sheetId,
        sheetTitle: sheet.properties.title,
        rangeA1: `${quoteSheet(sheet.properties.title)}!${boxToCells(run)}`,
        conditionType: condition.type ?? null,
        ruleKind: ruleKind(condition.type),
        values: (condition.values ?? []).map((v) => v.userEnteredValue ?? v),
        strict: run.rule?.strict ?? false,
        showCustomUi: run.rule?.showCustomUi ?? false,
        inputMessage: run.rule?.inputMessage ?? null,
      });
    }
  }
  return out;
}

const getDataValidationRules: GoogleTool = {
  name: 'get_data_validation_rules',
  title: 'List data validation',
  description: 'List data validation rules (dropdowns, checkboxes, formulas) with the A1 range each covers. Filter by sheetId, sheetTitle or ranges.',
  inputSchema: schema(
    {
      spreadsheetId: SPREADSHEET_ID,
      sheetId: i('Only this sheet.'),
      sheetTitle: s('Only this sheet, by title.'),
      ranges: strs('Only these A1 ranges.'),
      includeEmpty: b('Also list cells without validation.', { default: false }),
    },
    ['spreadsheetId'],
  ),
  annotations: READ,
  async run(args, ctx) {
    const id = sid(args, 'spreadsheetId', 'spreadsheet_id');
    let ranges = strList(args, 'ranges').map(fixRange);
    const sheetId = int(args, 'sheetId', 'sheet_id');
    const sheetTitle = str(args, 'sheetTitle', 'sheet_title');
    if (!ranges.length && (sheetId !== undefined || sheetTitle !== undefined)) {
      const { sheet } = await pickSheet(ctx, id, { name: sheetTitle, id: sheetId });
      ranges = [quoteSheet(sheet.title)];
    }
    const result = await ctx.google.json<{ sheets?: GridSheet[] }>({
      url: `${S}/${enc(id)}`,
      query: { ranges, includeGridData: true, fields: 'sheets(properties(sheetId,title),data(startRow,startColumn,rowData(values(dataValidation))))' },
    });
    const rules = (result?.sheets ?? []).flatMap((sheet) => validationRanges(sheet, flag(args, 'includeEmpty', 'include_empty') ?? false));
    return { spreadsheetId: id, rules, displayUrl: sheetUrl(id) };
  },
};

const getConditionalFormatRules: GoogleTool = {
  name: 'get_conditional_format_rules',
  title: 'List conditional formatting',
  description: 'List the conditional format rules of each sheet, with each rule\'s index (for mutate_conditional_format_rules) and its ranges in A1 notation.',
  inputSchema: schema(
    {
      spreadsheet_id: SPREADSHEET_ID,
      sheet_id: i('Only this sheet. Wins over sheet_title.'),
      sheet_title: s('Only this sheet, by title.'),
      exclude_tables_in_banded_ranges: b('Leave tables out of banded ranges.'),
    },
    ['spreadsheet_id'],
  ),
  annotations: READ,
  async run(args, ctx) {
    const id = sid(args);
    const result = await ctx.google.json<{ sheets?: GridSheet[] }>({
      url: `${S}/${enc(id)}`,
      query: { fields: 'sheets(properties(sheetId,title),conditionalFormats)', excludeTablesInBandedRanges: flag(args, 'exclude_tables_in_banded_ranges') },
    });
    const sheetId = int(args, 'sheet_id', 'sheetId');
    const title = str(args, 'sheet_title', 'sheetTitle');
    const sheets = (result?.sheets ?? [])
      .filter((sheet) => (sheetId !== undefined ? sheet.properties.sheetId === sheetId : title === undefined || sheet.properties.title === title))
      .map((sheet) => ({
        sheet_id: sheet.properties.sheetId,
        sheet_title: sheet.properties.title,
        rules: (sheet.conditionalFormats ?? []).map((rule, index) => ({
          index,
          ...rule,
          ranges_a1: ((rule.ranges as Json[] | undefined) ?? []).map((range) => a1FromGrid(sheet.properties.title, range)),
        })),
      }));
    return { spreadsheet_id: id, sheets, display_url: sheetUrl(id) };
  },
};

const mutateConditionalFormatRules: GoogleTool = {
  name: 'mutate_conditional_format_rules',
  title: 'Change conditional formatting',
  description:
    'ADD a rule, UPDATE (replace) the rule at index, DELETE the rule at index, or MOVE it to new_index. A rule has ranges (GridRanges) and a booleanRule {condition, format} or a gradientRule.',
  inputSchema: schema(
    {
      spreadsheet_id: SPREADSHEET_ID,
      sheet_id: i('Numeric sheet id.'),
      operation: s('ADD, UPDATE, DELETE or MOVE.', { enum: ['ADD', 'UPDATE', 'DELETE', 'MOVE'] }),
      rule: anyObj('ConditionalFormatRule. ranges without sheetId get sheet_id.'),
      index: i('Zero-based rule index. Required for UPDATE, DELETE and MOVE; ADD appends when omitted.'),
      new_index: i('Target index for MOVE.'),
    },
    ['spreadsheet_id', 'operation', 'sheet_id'],
  ),
  annotations: DESTRUCTIVE,
  async run(args, ctx) {
    const id = sid(args);
    const sheetId = reqInt(args, 'sheet_id', 'sheetId');
    const operation = enumArg(args, ['ADD', 'UPDATE', 'DELETE', 'MOVE'], undefined, 'operation');
    if (!operation) throw new ToolInputError('operation is required');
    const index = int(args, 'index');
    const notes: string[] = [];
    const rule = (): Json => {
      const given = objArg(args, 'rule');
      if (!given) throw new ToolInputError(`rule is required for ${operation}`);
      const ranges = ((given.ranges as unknown[] | undefined) ?? [{ sheetId }]).map((range) => gridFrom(range, sheetId));
      const boolean = given.booleanRule as { condition?: { type?: string; values?: Array<{ userEnteredValue?: string }> } } | undefined;
      for (const value of boolean?.condition?.type === 'CUSTOM_FORMULA' ? (boolean.condition.values ?? []) : []) {
        if (typeof value.userEnteredValue === 'string' && !value.userEnteredValue.startsWith('=')) {
          value.userEnteredValue = `=${value.userEnteredValue}`;
          notes.push('Kortix added a leading = to the CUSTOM_FORMULA value.');
        }
      }
      return { ...given, ranges };
    };
    const needIndex = () => {
      if (index === undefined) throw new ToolInputError(`index is required for ${operation}`);
      return index;
    };
    let request: Json;
    if (operation === 'ADD') request = { addConditionalFormatRule: { rule: rule(), index: index ?? 0 } };
    else if (operation === 'UPDATE') request = { updateConditionalFormatRule: { sheetId, index: needIndex(), rule: rule() } };
    else if (operation === 'DELETE') request = { deleteConditionalFormatRule: { sheetId, index: needIndex() } };
    else request = { updateConditionalFormatRule: { sheetId, index: needIndex(), newIndex: reqInt(args, 'new_index', 'newIndex') } };
    if (operation === 'ADD' && index === undefined) {
      const current = await ctx.google.json<{ sheets?: GridSheet[] }>({ url: `${S}/${enc(id)}`, query: { fields: 'sheets(properties(sheetId),conditionalFormats)' } });
      const count = current?.sheets?.find((sheet) => sheet.properties.sheetId === sheetId)?.conditionalFormats?.length ?? 0;
      (request.addConditionalFormatRule as Json).index = count;
    }
    const result = await batchUpdate(ctx, id, [request]);
    return { ...result, operation, sheet_id: sheetId, display_url: sheetUrl(id, sheetId), ...(notes.length ? { composio_execution_message: notes.join(' ') } : {}) };
  },
};

// ─── Charts ─────────────────────────────────────────────────────────────────

const BASIC_CHARTS = ['BAR', 'LINE', 'AREA', 'COLUMN', 'SCATTER', 'COMBO', 'STEPPED_AREA'];
const CHART_TYPES = [...BASIC_CHARTS, 'PIE', 'HISTOGRAM', 'BUBBLE', 'CANDLESTICK', 'TREEMAP', 'WATERFALL', 'ORG', 'SCORECARD'];
const CHART_MIN_COLUMNS: Record<string, number> = { PIE: 2, BUBBLE: 3, CANDLESTICK: 5, TREEMAP: 3, WATERFALL: 2, ORG: 2 };

/** One GridRange per column of a data range. */
function columnRanges(range: Json): Json[] {
  const start = range.startColumnIndex as number | undefined;
  const end = range.endColumnIndex as number | undefined;
  if (start === undefined || end === undefined) throw new ToolInputError('data_range must name its columns, such as A1:C10 or A:C');
  return Array.from({ length: end - start }, (_v, k) => ({ ...range, startColumnIndex: start + k, endColumnIndex: start + k + 1 }));
}

/** A ChartSpec for chart_type over data_range: the first column is the labels, the rest the series. */
function buildChartSpec(type: string, range: Json, args: Json): Json {
  const cols = columnRanges(range);
  const min = CHART_MIN_COLUMNS[type] ?? 1;
  if (cols.length < min) throw new ToolInputError(`${type} charts need at least ${min} columns in data_range`);
  const src = (r: Json) => ({ sourceRange: { sources: [r] } });
  const legendPosition = str(args, 'legend_position', 'legendPosition') ?? 'BOTTOM_LEGEND';
  if (BASIC_CHARTS.includes(type)) {
    const xTitle = str(args, 'x_axis_title', 'xAxisTitle');
    const yTitle = str(args, 'y_axis_title', 'yAxisTitle');
    const axis = [...(xTitle ? [{ position: 'BOTTOM_AXIS', title: xTitle }] : []), ...(yTitle ? [{ position: 'LEFT_AXIS', title: yTitle }] : [])];
    const [domain, ...series] = cols.length > 1 ? cols : [undefined, ...cols];
    return {
      basicChart: {
        chartType: type,
        legendPosition,
        headerCount: 1,
        ...(axis.length ? { axis } : {}),
        domains: domain ? [{ domain: src(domain) }] : [],
        series: series.map((col, k) => ({
          series: src(col!),
          targetAxis: type === 'BAR' ? 'BOTTOM_AXIS' : 'LEFT_AXIS',
          ...(type === 'COMBO' ? { type: k === 0 ? 'COLUMN' : 'LINE' } : {}),
        })),
      },
    };
  }
  const [c0, c1, c2, c3, c4] = cols;
  switch (type) {
    case 'PIE':
      return { pieChart: { legendPosition, domain: src(c0!), series: src(c1!) } };
    case 'HISTOGRAM':
      return { histogramChart: { legendPosition, series: cols.map((col) => ({ data: src(col) })) } };
    case 'SCORECARD':
      return { scorecardChart: { keyValueData: src(cols[cols.length - 1]!), aggregateType: 'SUM' } };
    case 'BUBBLE':
      return { bubbleChart: { legendPosition, bubbleLabels: src(c0!), domain: src(c1!), series: src(c2!), ...(c3 ? { bubbleSizes: src(c3) } : {}) } };
    case 'CANDLESTICK':
      return { candlestickChart: { domain: { data: src(c0!) }, data: [{ lowSeries: { data: src(c1!) }, openSeries: { data: src(c2!) }, closeSeries: { data: src(c3!) }, highSeries: { data: src(c4!) } }] } };
    case 'TREEMAP':
      return { treemapChart: { labels: src(c0!), parentLabels: src(c1!), sizeData: src(c2!) } };
    case 'WATERFALL':
      return { waterfallChart: { domain: { data: src(c0!) }, series: cols.slice(1).map((col) => ({ data: src(col) })) } };
    default:
      return { orgChart: { labels: src(c0!), parentLabels: src(c1!), ...(c2 ? { tooltips: src(c2) } : {}) } };
  }
}

async function findChart(ctx: ToolContext, spreadsheetId: string, chartId: number): Promise<{ chart?: Json; sheet?: SheetProps }> {
  const result = await ctx.google.json<{ sheets?: Array<{ properties: SheetProps; charts?: Json[] }> }>({
    url: `${S}/${enc(spreadsheetId)}`,
    query: { fields: 'sheets(properties(sheetId,title),charts)' },
  });
  for (const sheet of result?.sheets ?? []) {
    const chart = (sheet.charts ?? []).find((c) => c.chartId === chartId);
    if (chart) return { chart, sheet: sheet.properties };
  }
  return {};
}

const createChart: GoogleTool = {
  name: 'create_chart',
  title: 'Create chart',
  description:
    'Add a chart over a data range: the first column is the labels, the other columns the series. chart_spec sends a full Google ChartSpec instead. The chart is placed right of the data.',
  inputSchema: schema(
    {
      spreadsheet_id: SPREADSHEET_ID,
      sheet_id: i('Numeric id of the sheet the chart goes on (and of the data, when data_range has no sheet name).'),
      chart_type: s(`Chart type: ${CHART_TYPES.join(', ')}. PIE needs 2 columns.`),
      data_range: s('One contiguous range, such as A1:C10 or Sheet1!B2:D20.'),
      title: s('Chart title.'),
      subtitle: s('Chart subtitle.'),
      x_axis_title: s('X-axis title.'),
      y_axis_title: s('Y-axis title.'),
      legend_position: s('BOTTOM_LEGEND, TOP_LEGEND, LEFT_LEGEND, RIGHT_LEGEND or NO_LEGEND.', { default: 'BOTTOM_LEGEND' }),
      background_red: n('Background red, 0–1.'),
      background_green: n('Background green, 0–1.'),
      background_blue: n('Background blue, 0–1.'),
      chart_spec: anyObj('Full ChartSpec (basicChart, pieChart, …). Overrides the spec Kortix builds.'),
    },
    ['spreadsheet_id', 'sheet_id', 'chart_type', 'data_range'],
  ),
  annotations: WRITE,
  async run(args, ctx) {
    const id = sid(args);
    const sheetId = reqInt(args, 'sheet_id', 'sheetId');
    const type = reqStr(args, 'chart_type', 'chartType').replace(/[\s-]+/g, '_').toUpperCase();
    if (!CHART_TYPES.includes(type)) throw new ToolInputError(`chart_type must be one of ${CHART_TYPES.join(', ')}`);
    const dataRange = reqStr(args, 'data_range', 'dataRange');
    if (dataRange.includes(',')) throw new ToolInputError('data_range must be one contiguous range, not a list');
    const split = splitA1(dataRange);
    const box = parseBox(split.cells);
    if (!box) throw new ToolInputError(`data_range "${dataRange}" is not A1 notation`);
    const dataSheetId = split.sheet !== undefined ? (await pickSheet(ctx, id, { name: split.sheet })).sheet.sheetId : sheetId;
    const range = gridRange(dataSheetId, box);
    const spec: Json = objArg(args, 'chart_spec', 'chartSpec') ?? buildChartSpec(type, range, args);
    const title = str(args, 'title');
    const subtitle = str(args, 'subtitle');
    if (title && spec.title === undefined) spec.title = title;
    if (subtitle && spec.subtitle === undefined) spec.subtitle = subtitle;
    const rgb = { red: num(args, 'background_red'), green: num(args, 'background_green'), blue: num(args, 'background_blue') };
    if (Object.values(rgb).some((v) => v !== undefined)) spec.backgroundColorStyle = { rgbColor: { red: rgb.red ?? 1, green: rgb.green ?? 1, blue: rgb.blue ?? 1 } };
    const position = { overlayPosition: { anchorCell: { sheetId, rowIndex: box.startRow ?? 0, columnIndex: dataSheetId === sheetId ? (box.endCol ?? 0) + 1 : 0 } } };
    const result = await batchUpdate(ctx, id, [{ addChart: { chart: { spec, position } } }]);
    const chart = ((result.replies as Array<{ addChart?: { chart?: Json } }> | undefined)?.[0]?.addChart?.chart ?? {}) as Json;
    return { chart_id: chart.chartId, spreadsheet_id: id, chart, display_url: sheetUrl(id, sheetId) };
  },
};

const updateChart: GoogleTool = {
  name: 'update_chart',
  title: 'Update chart',
  description: 'Replace a chart\'s ChartSpec (type, title, ranges, colors, axes). Its position and size stay.',
  inputSchema: schema(
    { spreadsheet_id: SPREADSHEET_ID, chart_id: i('Chart id (list_charts).'), chart_spec: anyObj('The complete new ChartSpec, with exactly one chart type field.') },
    ['spreadsheet_id', 'chart_id', 'chart_spec'],
  ),
  annotations: IDEMPOTENT,
  async run(args, ctx) {
    const id = sid(args);
    const chartId = reqInt(args, 'chart_id', 'chartId');
    const spec = objArg(args, 'chart_spec', 'chartSpec');
    if (!spec) throw new ToolInputError('chart_spec is required');
    await batchUpdate(ctx, id, [{ updateChartSpec: { chartId, spec } }]);
    const found = await findChart(ctx, id, chartId);
    return { spreadsheet_id: id, chart_id: chartId, chart: found.chart ?? { chartId, spec }, display_url: sheetUrl(id, found.sheet?.sheetId) };
  },
};

const deleteChart: GoogleTool = {
  name: 'delete_chart',
  title: 'Delete chart',
  description: 'Delete a chart. Its data stays.',
  inputSchema: schema({ spreadsheet_id: SPREADSHEET_ID, chart_id: i('Chart id (list_charts).') }, ['spreadsheet_id', 'chart_id']),
  annotations: DESTRUCTIVE,
  async run(args, ctx) {
    const id = sid(args);
    const chartId = reqInt(args, 'chart_id', 'chartId');
    await batchUpdate(ctx, id, [{ deleteEmbeddedObject: { objectId: chartId } }]);
    return { spreadsheet_id: id, chart_id: chartId, display_url: sheetUrl(id) };
  },
};

const moveChart: GoogleTool = {
  name: 'move_chart',
  title: 'Move or resize chart',
  description:
    'Move a chart to a new sheet (new_sheet), to another sheet (target_sheet_id), or to an anchor cell with pixel offset and size (anchor_sheet_id with anchor_row_index and anchor_column_index).',
  inputSchema: schema(
    {
      spreadsheet_id: SPREADSHEET_ID,
      chart_id: i('Chart id (list_charts).'),
      new_sheet: b('Move the chart to a new sheet of its own.'),
      target_sheet_id: i('Move the chart to this sheet.'),
      anchor_sheet_id: i('Sheet of the anchor cell.'),
      anchor_row_index: i('Zero-based row of the anchor cell.'),
      anchor_column_index: i('Zero-based column of the anchor cell.'),
      offset_x_pixels: i('Horizontal offset from the anchor cell.'),
      offset_y_pixels: i('Vertical offset from the anchor cell.'),
      width_pixels: i('Chart width.'),
      height_pixels: i('Chart height.'),
    },
    ['spreadsheet_id', 'chart_id'],
  ),
  annotations: IDEMPOTENT,
  async run(args, ctx) {
    const id = sid(args);
    const chartId = reqInt(args, 'chart_id', 'chartId');
    const anchorSheet = int(args, 'anchor_sheet_id', 'anchorSheetId');
    const target = int(args, 'target_sheet_id', 'targetSheetId');
    const modes = [flag(args, 'new_sheet', 'newSheet') === true, target !== undefined, anchorSheet !== undefined].filter(Boolean).length;
    if (modes !== 1) throw new ToolInputError('Pass exactly one of new_sheet, target_sheet_id or anchor_sheet_id');
    let newPosition: Json;
    let fields: string;
    if (flag(args, 'new_sheet', 'newSheet')) {
      newPosition = { newSheet: true };
      fields = 'newSheet';
    } else if (target !== undefined) {
      newPosition = { sheetId: target };
      fields = 'sheetId';
    } else {
      const overlay: Json = {};
      const fieldList: string[] = [];
      const row = int(args, 'anchor_row_index', 'anchorRowIndex');
      const col = int(args, 'anchor_column_index', 'anchorColumnIndex');
      if (row !== undefined || col !== undefined) {
        if (row === undefined || col === undefined) throw new ToolInputError('anchor_row_index and anchor_column_index go together');
        overlay.anchorCell = { sheetId: anchorSheet, rowIndex: row, columnIndex: col };
        fieldList.push('overlayPosition.anchorCell');
      }
      for (const [snake, camel] of [['offset_x_pixels', 'offsetXPixels'], ['offset_y_pixels', 'offsetYPixels'], ['width_pixels', 'widthPixels'], ['height_pixels', 'heightPixels']] as const) {
        const value = int(args, snake, camel);
        if (value !== undefined) {
          overlay[camel] = value;
          fieldList.push(`overlayPosition.${camel}`);
        }
      }
      if (!fieldList.length) throw new ToolInputError('With anchor_sheet_id, pass the anchor cell, an offset or a size');
      newPosition = { overlayPosition: overlay };
      fields = fieldList.join(',');
    }
    const result = await batchUpdate(ctx, id, [{ updateEmbeddedObjectPosition: { objectId: chartId, newPosition, fields } }]);
    const position = (result.replies as Array<{ updateEmbeddedObjectPosition?: { position?: Json } }> | undefined)?.[0]?.updateEmbeddedObjectPosition?.position;
    return { spreadsheet_id: id, chart_id: chartId, replies: result.replies, new_position: position ?? newPosition, display_url: sheetUrl(id) };
  },
};

function chartType(spec: Json | undefined): string | null {
  if (!spec) return null;
  const basic = spec.basicChart as { chartType?: string } | undefined;
  if (basic?.chartType) return basic.chartType;
  const key = Object.keys(spec).find((k) => k.endsWith('Chart'));
  return key ? key.replace(/Chart$/, '').replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase() : null;
}

const listCharts: GoogleTool = {
  name: 'list_charts',
  title: 'List charts',
  description: 'List the charts of a spreadsheet: chartId, sheet, type, title and position. include_spec adds each full ChartSpec.',
  inputSchema: schema(
    {
      spreadsheet_id: SPREADSHEET_ID,
      sheet_id: i('Only charts on this sheet.'),
      chart_id: i('Only this chart.'),
      include_spec: b('Include each full ChartSpec.', { default: false }),
    },
    ['spreadsheet_id'],
  ),
  annotations: READ,
  async run(args, ctx) {
    const id = sid(args);
    const result = await ctx.google.json<{ properties?: { title?: string }; sheets?: Array<{ properties: SheetProps; charts?: Array<Json & { spec?: Json }> }> }>({
      url: `${S}/${enc(id)}`,
      query: { fields: 'properties(title),sheets(properties(sheetId,title),charts)' },
    });
    const sheetId = int(args, 'sheet_id', 'sheetId');
    const chartId = int(args, 'chart_id', 'chartId');
    const includeSpec = flag(args, 'include_spec', 'includeSpec') ?? false;
    const charts = (result?.sheets ?? [])
      .filter((sheet) => sheetId === undefined || sheet.properties.sheetId === sheetId)
      .flatMap((sheet) =>
        (sheet.charts ?? [])
          .filter((chart) => chartId === undefined || chart.chartId === chartId)
          .map((chart) => ({
            chartId: chart.chartId,
            sheet_id: sheet.properties.sheetId,
            sheet_title: sheet.properties.title,
            chart_type: chartType(chart.spec),
            title: chart.spec?.title ?? null,
            subtitle: chart.spec?.subtitle ?? null,
            position: chart.position ?? null,
            ...(includeSpec ? { spec: chart.spec } : {}),
          })),
      );
    return { spreadsheetId: id, spreadsheet_title: result?.properties?.title ?? '', charts, total_count: charts.length, display_url: sheetUrl(id) };
  },
};

// ─── Drive ──────────────────────────────────────────────────────────────────

const DRIVE_SYNTAX = /(\bcontains\b|[=<>]|\bin\s+(parents|owners|writers|readers)\b|\bsharedWithMe\b|\btrashed\b|\bstarred\b)/;
const SEARCH_FIELDS =
  'nextPageToken,incompleteSearch,files(id,name,mimeType,createdTime,modifiedTime,webViewLink,starred,trashed,shared,size,owners(displayName,emailAddress),lastModifyingUser(displayName,emailAddress))';

function spreadsheetQuery(args: Json): { q: string; fullText: boolean } {
  const parts = [`mimeType='${SHEET_MIME}'`];
  if (!(flag(args, 'include_trashed', 'includeTrashed') ?? false)) parts.push('trashed=false');
  const query = str(args, 'query', 'q');
  let fullText = false;
  if (query) {
    if (DRIVE_SYNTAX.test(query)) {
      parts.push(`(${query})`);
      fullText = /\bfullText\b/.test(query);
    } else {
      const type = (str(args, 'search_type', 'searchType') ?? 'name').toLowerCase();
      const literal = driveLiteral(query);
      if (type === 'content') parts.push(`fullText contains ${literal}`);
      else if (type === 'both') parts.push(`(name contains ${literal} or fullText contains ${literal})`);
      else parts.push(`name contains ${literal}`);
      fullText = type === 'content' || type === 'both';
    }
  }
  if (flag(args, 'starred_only', 'starredOnly')) parts.push('starred=true');
  if (flag(args, 'shared_with_me', 'sharedWithMe')) parts.push('sharedWithMe=true');
  const created = str(args, 'created_after', 'createdAfter');
  const modified = str(args, 'modified_after', 'modifiedAfter');
  if (created) parts.push(`createdTime > ${driveLiteral(created)}`);
  if (modified) parts.push(`modifiedTime > ${driveLiteral(modified)}`);
  return { q: parts.join(' and '), fullText };
}

const searchSpreadsheets: GoogleTool = {
  name: 'search_spreadsheets',
  title: 'Search spreadsheets',
  description:
    'Find spreadsheets in Drive by name (prefix of a word), content, dates, starred or shared-with-me. query also takes Drive syntax, such as `name contains \'Budget\'`. Page with page_token.',
  inputSchema: schema({
    query: s('Words to find, or a Drive query. Empty lists every spreadsheet.'),
    search_type: s('name, content (full text) or both.', { enum: ['name', 'content', 'both'], default: 'name' }),
    max_results: i('Results per page, 1–1000.', { default: 10 }),
    page_token: s('next_page_token of the previous page. pageToken is an alias.'),
    order_by: s('Sort, such as modifiedTime desc or name. Ignored for content searches.', { default: 'modifiedTime desc' }),
    starred_only: b('Only starred spreadsheets.', { default: false }),
    shared_with_me: b('Only spreadsheets shared with the account.', { default: false }),
    include_trashed: b('Include trashed spreadsheets.', { default: false }),
    include_shared_drives: b('Include shared drives.', { default: true }),
    created_after: s('RFC 3339 time, such as 2026-01-01T00:00:00Z.'),
    modified_after: s('RFC 3339 time.'),
  }),
  annotations: READ,
  async run(args, ctx) {
    const { q, fullText } = spreadsheetQuery(args);
    const shared = flag(args, 'include_shared_drives', 'includeSharedDrives') ?? true;
    const result = await ctx.google.json<{ files?: Array<Json & { id: string }>; nextPageToken?: string; incompleteSearch?: boolean }>({
      url: `${DRIVE}/files`,
      query: {
        q,
        pageSize: Math.min(Math.max(int(args, 'max_results', 'maxResults') ?? 10, 1), 1000),
        pageToken: str(args, 'page_token', 'pageToken'),
        orderBy: fullText ? undefined : (str(args, 'order_by', 'orderBy') ?? 'modifiedTime desc'),
        fields: SEARCH_FIELDS,
        supportsAllDrives: true,
        includeItemsFromAllDrives: shared,
        ...(shared ? { corpora: 'allDrives' } : {}),
      },
    });
    const spreadsheets = (result?.files ?? []).map((file) => ({ ...file, display_url: sheetUrl(file.id) }));
    return {
      spreadsheets,
      total_found: spreadsheets.length,
      next_page_token: result?.nextPageToken ?? null,
      nextPageToken: result?.nextPageToken ?? null,
      incomplete_search: result?.incompleteSearch ?? false,
      search_message: spreadsheets.length
        ? `Found ${spreadsheets.length} spreadsheet${spreadsheets.length === 1 ? '' : 's'}${result?.nextPageToken ? '; more on the next page' : ''}.`
        : "No spreadsheets matched. A name search matches word prefixes; try search_type 'both' or fewer words.",
    };
  },
};

const getDriveFileMetadata: GoogleTool = {
  name: 'get_drive_file_metadata',
  title: 'Get Drive file metadata',
  description: 'Drive metadata of one file (a spreadsheet id is its Drive file id): name, owners, parents, times, links. fields picks the fields.',
  inputSchema: schema(
    {
      fileId: s('Drive file id.'),
      fields: s('Drive field mask, such as id,name,mimeType,modifiedTime or permissions(id,emailAddress,role).'),
      includeLabels: s('Comma-separated Drive label ids for labelInfo.'),
      includePermissionsForView: s('published to include the published view\'s permissions.'),
      supportsAllDrives: b('Support shared-drive files.', { default: true }),
    },
    ['fileId'],
  ),
  annotations: READ,
  run: (args, ctx) =>
    ctx.google.json({
      url: `${DRIVE}/files/${enc(sid(args, 'fileId', 'file_id'))}`,
      query: {
        fields: str(args, 'fields'),
        includeLabels: str(args, 'includeLabels', 'include_labels'),
        includePermissionsForView: str(args, 'includePermissionsForView', 'include_permissions_for_view'),
        supportsAllDrives: flag(args, 'supportsAllDrives', 'supports_all_drives') ?? true,
      },
    }),
};

const moveSpreadsheetToFolder: GoogleTool = {
  name: 'move_spreadsheet_to_folder',
  title: 'Move spreadsheet to folder',
  description: 'Move a spreadsheet into a Drive folder, out of its current folders.',
  inputSchema: schema({ spreadsheet_id: SPREADSHEET_ID, destination_folder_id: s('Drive folder id.') }, ['spreadsheet_id', 'destination_folder_id']),
  annotations: IDEMPOTENT,
  async run(args, ctx) {
    const id = sid(args);
    const moved = await moveToFolder(ctx, id, reqStr(args, 'destination_folder_id', 'destinationFolderId', 'folder_id'));
    return { spreadsheet_id: id, name: moved.name, mime_type: moved.mimeType ?? SHEET_MIME, parent_ids: moved.parents, previous_parent_ids: moved.previous, display_url: sheetUrl(id) };
  },
};

const EXPORT_TYPES: Record<string, string> = {
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.oasis.opendocument.spreadsheet': 'ods',
  'application/pdf': 'pdf',
  'application/zip': 'zip',
  'text/csv': 'csv',
  'text/tab-separated-values': 'tsv',
};

async function driveExport(ctx: ToolContext, fileId: string, mimeType: string): Promise<Uint8Array> {
  const { data } = await ctx.google.bytes({ url: `${DRIVE}/files/${enc(fileId)}/export`, query: { mimeType } });
  return data;
}

const exportDriveFile: GoogleTool = {
  name: 'export_drive_file',
  title: 'Export spreadsheet',
  description:
    'Export a whole spreadsheet as XLSX, ODS, PDF, zipped HTML, CSV or TSV (CSV and TSV: first sheet only). The file comes back as `file.content_base64`; Google caps exports at 10 MB.',
  inputSchema: schema(
    { file_id: s('Spreadsheet id (its Drive file id).'), mime_type: s('Export format.', { enum: Object.keys(EXPORT_TYPES) }) },
    ['file_id', 'mime_type'],
  ),
  annotations: READ,
  async run(args, ctx) {
    const fileId = sid(args, 'file_id', 'fileId');
    const mimeType = reqStr(args, 'mime_type', 'mimeType');
    const extension = EXPORT_TYPES[mimeType];
    if (!extension) throw new ToolInputError(`mime_type must be one of ${Object.keys(EXPORT_TYPES).join(', ')}`);
    const meta = await ctx.google.json<{ name?: string }>({ url: `${DRIVE}/files/${enc(fileId)}`, query: { fields: 'name', supportsAllDrives: true } });
    const data = await driveExport(ctx, fileId, mimeType);
    return { file: fileOutput(`${meta?.name ?? fileId}.${extension}`, mimeType, data) };
  },
};

/** Delete everything outside [start, end) of one dimension of a sheet. */
function trimRequests(sheetId: number, dimension: 'ROWS' | 'COLUMNS', start: number | undefined, end: number | undefined, size: number): Json[] {
  const requests: Json[] = [];
  if (end !== undefined && end < size) requests.push({ deleteDimension: { range: { sheetId, dimension, startIndex: end, endIndex: size } } });
  if (start !== undefined && start > 0) requests.push({ deleteDimension: { range: { sheetId, dimension, startIndex: 0, endIndex: start } } });
  return requests;
}

const exportSheetAsPdf: GoogleTool = {
  name: 'export_sheet_as_pdf',
  title: 'Export one sheet as PDF',
  description:
    'Render one sheet, or a cell rectangle of it, as a PDF (`file.content_base64`). Kortix copies the sheet with its values into a temporary spreadsheet, exports it through Drive, then deletes it. Google\'s default print layout applies: orientation, margins, gridlines and fit-to-width are not set.',
  inputSchema: schema(
    {
      spreadsheet_id: SPREADSHEET_ID,
      sheet_id: i('Numeric id (gid) of the sheet to export.'),
      start_row_index: i('Zero-based first row to include.'),
      end_row_index: i('Zero-based last row, exclusive.'),
      start_column_index: i('Zero-based first column to include.'),
      end_column_index: i('Zero-based last column, exclusive.'),
      portrait: b('Not applied: Drive exports use the default orientation.', { default: true }),
      fit_to_width: b('Not applied.', { default: true }),
      show_gridlines: b('Not applied.', { default: false }),
      show_sheet_name: b('Not applied.', { default: false }),
      print_titles: b('Not applied.', { default: false }),
      repeat_frozen_rows: b('Not applied.', { default: true }),
      top_margin: n('Not applied.', { default: 0.5 }),
      bottom_margin: n('Not applied.', { default: 0.25 }),
      left_margin: n('Not applied.', { default: 0.5 }),
      right_margin: n('Not applied.', { default: 0.5 }),
    },
    ['spreadsheet_id', 'sheet_id'],
  ),
  annotations: READ,
  async run(args, ctx) {
    const id = sid(args);
    const { sheet } = await pickSheet(ctx, id, { id: reqInt(args, 'sheet_id', 'sheetId') });
    const temp = await ctx.google.json<{ spreadsheetId: string; sheets?: Array<{ properties: SheetProps }> }>({
      method: 'POST',
      url: S,
      body: { properties: { title: `${sheet.title} (Kortix PDF export)` } },
    });
    try {
      const copy = await ctx.google.json<SheetProps>({ method: 'POST', url: `${S}/${enc(id)}/sheets/${sheet.sheetId}:copyTo`, body: { destinationSpreadsheetId: temp.spreadsheetId } });
      // Formulas that point at other sheets break in the copy: write the computed values over them.
      const source = await readValues(ctx, id, quoteSheet(sheet.title), { valueRenderOption: 'UNFORMATTED_VALUE', dateTimeRenderOption: 'SERIAL_NUMBER' });
      if (source.values.length) {
        const width = Math.max(1, ...source.values.map((row) => row.length));
        const range = joinA1(copy.title, boxToCells({ startRow: 0, startCol: 0, endRow: source.values.length, endCol: width }));
        await ctx.google.json({ method: 'PUT', url: `${S}/${enc(temp.spreadsheetId)}/values/${enc(range)}`, query: { valueInputOption: 'RAW' }, body: { range, values: source.values } });
      }
      const rows = copy.gridProperties?.rowCount ?? 0;
      const cols = copy.gridProperties?.columnCount ?? 0;
      const requests: Json[] = [
        ...(temp.sheets ?? []).map((s0) => ({ deleteSheet: { sheetId: s0.properties.sheetId } })),
        { updateSheetProperties: { properties: { sheetId: copy.sheetId, title: sheet.title }, fields: 'title' } },
        ...trimRequests(copy.sheetId, 'ROWS', int(args, 'start_row_index'), int(args, 'end_row_index'), rows),
        ...trimRequests(copy.sheetId, 'COLUMNS', int(args, 'start_column_index'), int(args, 'end_column_index'), cols),
      ];
      await batchUpdate(ctx, temp.spreadsheetId, requests);
      const data = await driveExport(ctx, temp.spreadsheetId, 'application/pdf');
      return { file: fileOutput(`${sheet.title}.pdf`, 'application/pdf', data) };
    } finally {
      await ctx.google.json({ method: 'DELETE', url: `${DRIVE}/files/${enc(temp.spreadsheetId)}`, query: { supportsAllDrives: true } }).catch(() => null);
    }
  },
};

const listDriveChanges: GoogleTool = {
  name: 'list_drive_changes',
  title: 'List Drive changes',
  description:
    'Without page_token: start watching and get a checkpoint (new_start_page_token). With page_token: the Drive changes since that checkpoint. Keep calling with next_page_token, then save new_start_page_token.',
  inputSchema: schema({
    page_token: s('Checkpoint or next_page_token. pageToken is an alias.'),
    page_size: i('Changes per page, 1–1000.', { default: 100 }),
    drive_id: s('Shared drive whose changes to read.'),
    spaces: s('drive or appDataFolder, comma-separated.', { default: 'drive' }),
    include_removed: b('Include removals and lost access.', { default: true }),
    include_corpus_removals: b('Include files removed from the corpus but still readable.', { default: false }),
    include_items_from_all_drives: b('Include shared-drive items.', { default: false }),
    supports_all_drives: b('Support shared drives.', { default: false }),
    restrict_to_my_drive: b('Only My Drive.', { default: false }),
    include_labels: s('Comma-separated label ids for labelInfo.'),
    include_permissions_for_view: s('published to include the published view\'s permissions.'),
  }),
  annotations: READ,
  async run(args, ctx) {
    const driveId = str(args, 'drive_id', 'driveId');
    const allDrives = driveId !== undefined;
    const token = str(args, 'page_token', 'pageToken');
    if (!token) {
      const start = await ctx.google.json<{ startPageToken?: string }>({
        url: `${DRIVE}/changes/startPageToken`,
        query: { driveId, supportsAllDrives: allDrives || (flag(args, 'supports_all_drives', 'supportsAllDrives') ?? false) },
      });
      return { kind: 'drive#changeList', changes: [], next_page_token: null, nextPageToken: null, new_start_page_token: start?.startPageToken ?? null, newStartPageToken: start?.startPageToken ?? null };
    }
    const corpus = flag(args, 'include_corpus_removals', 'includeCorpusRemovals') ?? false;
    const result = await ctx.google.json<Json>({
      url: `${DRIVE}/changes`,
      query: {
        pageToken: token,
        pageSize: Math.min(Math.max(int(args, 'page_size', 'pageSize') ?? 100, 1), 1000),
        spaces: str(args, 'spaces') ?? 'drive',
        driveId,
        includeRemoved: corpus || (flag(args, 'include_removed', 'includeRemoved') ?? true),
        includeCorpusRemovals: corpus,
        includeItemsFromAllDrives: allDrives || (flag(args, 'include_items_from_all_drives', 'includeItemsFromAllDrives') ?? false),
        supportsAllDrives: allDrives || (flag(args, 'supports_all_drives', 'supportsAllDrives') ?? false),
        restrictToMyDrive: flag(args, 'restrict_to_my_drive', 'restrictToMyDrive') ?? false,
        includeLabels: str(args, 'include_labels', 'includeLabels'),
        includePermissionsForView: str(args, 'include_permissions_for_view', 'includePermissionsForView'),
      },
    });
    return {
      kind: result?.kind ?? 'drive#changeList',
      changes: result?.changes ?? [],
      next_page_token: result?.nextPageToken ?? null,
      nextPageToken: result?.nextPageToken ?? null,
      new_start_page_token: result?.newStartPageToken ?? null,
      newStartPageToken: result?.newStartPageToken ?? null,
    };
  },
};

// ─── Computed tools: shared reading ─────────────────────────────────────────

/** A sheet's values from row 1, with numbers as numbers and dates as text. */
async function readGrid(ctx: ToolContext, spreadsheetId: string, sheet: SheetProps, opts: { render?: string; maxRows?: number } = {}): Promise<unknown[][]> {
  const rows = sheet.gridProperties?.rowCount;
  const range = opts.maxRows && rows ? `${quoteSheet(sheet.title)}!1:${Math.min(rows, opts.maxRows)}` : quoteSheet(sheet.title);
  const result = await readValues(ctx, spreadsheetId, range, { valueRenderOption: opts.render ?? 'UNFORMATTED_VALUE', dateTimeRenderOption: 'FORMATTED_STRING' });
  return result.values;
}

/** A column by header name (case-insensitive), else by letter. */
function columnIndex(name: string, headers: string[], offset = 0): number {
  const wanted = name.trim().toLowerCase();
  const byHeader = headers.findIndex((header) => header.trim().toLowerCase() === wanted);
  if (byHeader >= 0) return byHeader;
  if (/^[A-Za-z]{1,3}$/.test(name.trim())) return colToIndex(name.trim()) - offset;
  throw new ToolInputError(`Column "${name}" is neither a header nor a column letter. The headers are: ${headers.filter(Boolean).join(', ') || 'none'}`);
}

const aggregateColumnData: GoogleTool = {
  name: 'aggregate_column_data',
  title: 'Aggregate a column',
  description:
    'Sum, average, count, min, max or percentage of one column, over all rows or the rows where search_column equals search_value (plus additional_filters). Columns are header names or letters. count counts non-empty target cells.',
  inputSchema: schema(
    {
      spreadsheet_id: SPREADSHEET_ID,
      sheet_name: s('Sheet name; case-insensitive, and a partial name matches.'),
      target_column: s('Column to aggregate: header name or letter.'),
      operation: s('sum, average, count, min, max or percentage.', { enum: ['sum', 'average', 'count', 'min', 'max', 'percentage'] }),
      search_column: s('Column to filter on: header name or letter.'),
      search_value: s('Exact value search_column must have.'),
      additional_filters: arr({ type: 'object', properties: { column: s('Header name or letter.'), value: s('Exact value.') }, required: ['column', 'value'] }, 'More column = value conditions, combined with AND.'),
      case_sensitive: b('Case-sensitive matching.', { default: true }),
      has_header_row: b('The first row holds headers.', { default: true }),
      percentage_total: n('Total for percentage. Default: the sum of the whole column.'),
    },
    ['spreadsheet_id', 'sheet_name', 'target_column', 'operation'],
  ),
  annotations: READ,
  async run(args, ctx) {
    const id = sid(args);
    const operation = reqStr(args, 'operation').toLowerCase();
    if (!['sum', 'average', 'count', 'min', 'max', 'percentage'].includes(operation)) throw new ToolInputError('operation must be sum, average, count, min, max or percentage');
    const { sheet } = await pickSheet(ctx, id, { name: reqStr(args, 'sheet_name', 'sheetName'), partial: true });
    const grid = await readGrid(ctx, id, sheet);
    const hasHeader = flag(args, 'has_header_row', 'hasHeaderRow') ?? true;
    const headers = hasHeader ? (grid[0] ?? []).map(cellString) : [];
    const rows = hasHeader ? grid.slice(1) : grid;
    const targetName = reqStr(args, 'target_column', 'targetColumn');
    const target = columnIndex(targetName, headers);
    const caseSensitive = flag(args, 'case_sensitive', 'caseSensitive') ?? true;
    const same = (a: unknown, b: string) => (caseSensitive ? cellString(a).trim() === b.trim() : cellString(a).trim().toLowerCase() === b.trim().toLowerCase());
    const searchColumn = str(args, 'search_column', 'searchColumn');
    const searchValue = typeof args.search_value === 'string' || typeof args.search_value === 'number' ? String(args.search_value) : undefined;
    const filters: Array<{ col: number; value: string }> = [];
    if (searchColumn && searchValue !== undefined) filters.push({ col: columnIndex(searchColumn, headers), value: searchValue });
    for (const filter of listArg(args, 'additional_filters', 'additionalFilters') ?? []) {
      const f = (filter ?? {}) as Json;
      const column = optStr(f, 'column');
      if (!column || f.value === undefined) throw new ToolInputError('each additional_filters item needs column and value');
      filters.push({ col: columnIndex(column, headers), value: String(f.value) });
    }
    const matching = rows.filter((row) => filters.every((f) => same(row?.[f.col], f.value)));
    const numbers = matching.map((row) => cellNumber(row?.[target])).filter((v): v is number => v !== null);
    const sum = numbers.reduce((a, v) => a + v, 0);
    let result = 0;
    if (operation === 'sum') result = sum;
    else if (operation === 'average') result = numbers.length ? sum / numbers.length : 0;
    else if (operation === 'count') result = matching.filter((row) => !isEmptyCell(row?.[target])).length;
    else if (operation === 'min') result = numbers.length ? Math.min(...numbers) : 0;
    else if (operation === 'max') result = numbers.length ? Math.max(...numbers) : 0;
    else {
      const total = num(args, 'percentage_total', 'percentageTotal') ?? rows.map((row) => cellNumber(row?.[target])).reduce<number>((a, v) => a + (v ?? 0), 0);
      result = total ? (sum / total) * 100 : 0;
    }
    return {
      result,
      operation,
      values_processed: numbers,
      processed_values_count: operation === 'count' ? result : numbers.length,
      matching_rows_count: matching.length,
      search_details: { search_column: searchColumn ?? null, search_value: searchValue ?? null, target_column: targetName, case_sensitive: caseSensitive, aggregated_all_rows: filters.length === 0 },
      display_url: sheetUrl(id, sheet.sheetId),
    };
  },
};

/** NFKC, no zero-width or soft-hyphen characters, non-breaking spaces as spaces. */
function normalizeCell(value: string, caseSensitive: boolean, trim: boolean): string {
  let out = value.normalize('NFKC').replace(/[​-‍⁠﻿­]/g, '').replace(/ /g, ' ');
  if (trim) out = out.trim();
  return caseSensitive ? out : out.toLowerCase();
}

const lookupSpreadsheetRow: GoogleTool = {
  name: 'lookup_spreadsheet_row',
  title: 'Find a row',
  description:
    'Find the first row with a cell equal to query, in range or the first sheet. Matching ignores case and surrounding spaces by default. Returns the row\'s values and its row_number.',
  inputSchema: schema(
    {
      spreadsheet_id: SPREADSHEET_ID,
      query: s('Exact cell content to find.'),
      range: s("A1 range to search, such as Sheet1!A:Z or 'My Sheet'!A1:D500. Default: the first sheet."),
      case_sensitive: b('Case-sensitive matching.', { default: false }),
      normalize_whitespace: b('Ignore spaces around cell values.', { default: true }),
      value_render_option: s('FORMATTED_VALUE, UNFORMATTED_VALUE or FORMULA.', { enum: [...VALUE_RENDER], default: 'UNFORMATTED_VALUE' }),
      date_time_render_option: s('SERIAL_NUMBER or FORMATTED_STRING.', { enum: [...DATE_RENDER] }),
    },
    ['spreadsheet_id', 'query'],
  ),
  annotations: READ,
  async run(args, ctx) {
    const id = sid(args);
    const given = str(args, 'range');
    const range = given ? fixRange(given) : await firstSheetRange(ctx, id);
    const result = await readValues(ctx, id, range, {
      valueRenderOption: enumArg(args, VALUE_RENDER, 'UNFORMATTED_VALUE', 'value_render_option', 'valueRenderOption'),
      dateTimeRenderOption: enumArg(args, DATE_RENDER, undefined, 'date_time_render_option', 'dateTimeRenderOption'),
    });
    const caseSensitive = flag(args, 'case_sensitive', 'caseSensitive') ?? false;
    const trim = flag(args, 'normalize_whitespace', 'normalizeWhitespace') ?? true;
    const query = normalizeCell(reqStr(args, 'query'), caseSensitive, trim);
    const index = result.values.findIndex((row) => (row ?? []).some((cell) => normalizeCell(cellString(cell), caseSensitive, trim) === query));
    if (index < 0) return { row_data: { found: false, row_data: [] }, display_url: sheetUrl(id) };
    return {
      row_data: { found: true, row_data: result.values[index]!.map(cellString) },
      row_number: firstRowOf(result.range) + index,
      range: result.range,
      display_url: sheetUrl(id),
    };
  },
};

// ─── upsert_rows ────────────────────────────────────────────────────────────

function upsertInput(args: Json): { headers: string[]; rows: unknown[][]; note: string } {
  const rows = values2d(args, 'rows');
  let headers = (listArg(args, 'headers') ?? []).map((h) => cellString(h).trim());
  let data = rows;
  if (!headers.length) {
    if (rows.length < 2) throw new ToolInputError('Without headers, rows needs a header row and at least one data row');
    headers = rows[0]!.map((h) => cellString(h).trim());
    data = rows.slice(1);
  }
  if (headers.some((h) => !h)) throw new ToolInputError('Every header needs a name');
  const lower = headers.map((h) => h.toLowerCase());
  const duplicate = lower.find((h, k) => lower.indexOf(h) !== k);
  if (duplicate) throw new ToolInputError(`Header "${duplicate}" appears twice`);
  const long = data.map((row, k) => ({ row: k + 1, extra: row.length - headers.length })).filter((r) => r.extra > 0);
  let note = '';
  if (long.length) {
    if (flag(args, 'strictMode', 'strict_mode') ?? true) {
      throw new ToolInputError(
        `${long.length} row(s) have more values than the ${headers.length} headers: data rows ${long.map((r) => `${r.row} (+${r.extra})`).join(', ')}. Remove the extra values, add headers, or set strictMode false to drop them.`,
      );
    }
    data = data.map((row) => row.slice(0, headers.length));
    note = `Kortix dropped extra values from ${long.length} row(s).`;
  }
  return { headers, rows: data, note };
}

function upsertKey(args: Json, headers: string[], sheetHeaders: string[], startCol: number): string {
  const name = str(args, 'keyColumn', 'key_column');
  if (name) {
    const match = headers.find((h) => h.toLowerCase() === name.trim().toLowerCase());
    if (match) return match;
    if (/^[A-Za-z]{1,3}$/.test(name.trim())) {
      const index = colToIndex(name.trim()) - startCol;
      const header = sheetHeaders[index] ?? headers[index];
      const found = header ? headers.find((h) => h.toLowerCase() === header.toLowerCase()) : undefined;
      if (found) return found;
    }
    throw new ToolInputError(`keyColumn "${name}" is not one of the headers: ${headers.join(', ')}`);
  }
  const index = int(args, 'key_column_index', 'keyColumnIndex') ?? 0;
  const header = headers[index];
  if (!header) throw new ToolInputError(`key_column_index ${index} is outside the ${headers.length} headers`);
  return header;
}

/** One range per run of adjacent columns of one row. */
function rowRuns(title: string, row: number, cells: Array<{ col: number; value: unknown }>): Array<{ range: string; values: unknown[][] }> {
  const sorted = [...cells].sort((a, b) => a.col - b.col);
  const out: Array<{ range: string; values: unknown[][] }> = [];
  let run: Array<{ col: number; value: unknown }> = [];
  const flush = () => {
    if (!run.length) return;
    const first = run[0]!.col;
    out.push({ range: joinA1(title, boxToCells({ startRow: row - 1, endRow: row, startCol: first, endCol: first + run.length })), values: [run.map((c) => c.value)] });
    run = [];
  };
  for (const cell of sorted) {
    if (run.length && cell.col !== run[run.length - 1]!.col + 1) flush();
    run.push(cell);
  }
  flush();
  return out;
}

async function upsertRows(args: Json, ctx: ToolContext): Promise<Json> {
  const id = sid(args, 'spreadsheetId', 'spreadsheet_id');
  const { sheet } = await pickSheet(ctx, id, { name: reqStr(args, 'sheetName', 'sheet_name'), defaultName: true });
  const start = parseCellRef(str(args, 'tableStart', 'table_start') ?? 'A1');
  if (!start || start.col === undefined || start.row === undefined) throw new ToolInputError('tableStart must be one cell, such as A1 or C5');
  const input = upsertInput(args);
  const grid = (await readGrid(ctx, id, sheet)).slice(start.row).map((row) => (row ?? []).slice(start.col!));
  const sheetHeaders = (grid[0] ?? []).map((h) => cellString(h).trim());
  while (sheetHeaders.length && !sheetHeaders[sheetHeaders.length - 1]) sheetHeaders.pop();
  const colOf = new Map<string, number>();
  sheetHeaders.forEach((h, k) => {
    if (h && !colOf.has(h.toLowerCase())) colOf.set(h.toLowerCase(), k);
  });
  const added = input.headers.filter((h) => !colOf.has(h.toLowerCase()));
  added.forEach((h, k) => colOf.set(h.toLowerCase(), sheetHeaders.length + k));
  const width = sheetHeaders.length + added.length;
  const writes: Array<{ range: string; values: unknown[][] }> = [];
  if (added.length) writes.push({ range: joinA1(sheet.title, boxToCells({ startRow: start.row, endRow: start.row + 1, startCol: start.col + sheetHeaders.length, endCol: start.col + width })), values: [added] });
  const keyHeader = upsertKey(args, input.headers, sheetHeaders, start.col);
  const keySheetCol = colOf.get(keyHeader.toLowerCase())!;
  const keyInputCol = input.headers.findIndex((h) => h.toLowerCase() === keyHeader.toLowerCase());
  const existing = new Map<string, number>();
  for (let r = 1; r < grid.length; r++) {
    const key = cellString(grid[r]?.[keySheetCol]).trim();
    if (key && !existing.has(key)) existing.set(key, r);
  }
  const appended: unknown[][] = [];
  const pending = new Map<string, number>();
  let updated = 0;
  for (const row of input.rows) {
    const key = cellString(row[keyInputCol]).trim();
    const set = input.headers.map((h, j) => ({ col: colOf.get(h.toLowerCase())!, value: row[j] })).filter((c) => c.value !== undefined && c.value !== null);
    const at = key ? existing.get(key) : undefined;
    if (at !== undefined) {
      updated++;
      // The key cell already holds the key: leave it untouched.
      const changes = set.filter((c) => c.col !== keySheetCol).map((c) => ({ col: start.col! + c.col, value: c.value }));
      writes.push(...rowRuns(sheet.title, start.row + at + 1, changes));
      continue;
    }
    const target = key && pending.has(key) ? appended[pending.get(key)!]! : new Array<unknown>(width).fill('');
    for (const c of set) target[c.col] = c.value;
    if (!(key && pending.has(key))) {
      appended.push(target);
      if (key) pending.set(key, appended.length - 1);
    }
  }
  const firstFree = start.row + Math.max(grid.length, 1);
  if (appended.length) writes.push({ range: joinA1(sheet.title, boxToCells({ startRow: firstFree, endRow: firstFree + appended.length, startCol: start.col, endCol: start.col + width })), values: appended });
  const grew = await ensureGrid(ctx, id, sheet, firstFree + appended.length, start.col + width);
  if (writes.length) await ctx.google.json({ method: 'POST', url: `${S}/${enc(id)}/values:batchUpdate`, body: { valueInputOption: 'USER_ENTERED', data: writes } });
  const message = [input.note, grew, !sheetHeaders.length ? 'The sheet had no header row: Kortix wrote one.' : ''].filter(Boolean).join(' ');
  return {
    spreadsheetId: id,
    sheetName: sheet.title,
    rowsUpdated: updated,
    rowsInserted: appended.length,
    columnsAdded: sheetHeaders.length ? added.length : 0,
    totalRowsProcessed: input.rows.length,
    displayUrl: sheetUrl(id, sheet.sheetId),
    ...(message ? { composioExecutionMessage: message } : {}),
  };
}

const upsertRowsTool: GoogleTool = {
  name: 'upsert_rows',
  title: 'Upsert rows',
  description:
    'Update rows whose key column matches, and append the others. Columns map by header name; missing headers are added. Without headers, the first row of rows is the header row. null or missing values leave a cell unchanged.',
  inputSchema: schema(
    {
      spreadsheetId: SPREADSHEET_ID,
      sheetName: s('Sheet name; case-insensitive.'),
      rows: ROWS_SCHEMA,
      headers: strs('Column names of rows. Omit to use the first row of rows.'),
      keyColumn: s('Header that identifies a row, such as Email. A column letter is turned into its header.'),
      key_column_index: i('Zero-based index into headers of the key column. Default 0.'),
      tableStart: s('Cell of the first header.', { default: 'A1' }),
      strictMode: b('Refuse rows with more values than headers (false: drop the extra values).', { default: true }),
    },
    ['spreadsheetId', 'sheetName', 'rows'],
  ),
  annotations: WRITE,
  run: (args, ctx) => upsertRows(args, ctx),
};

// ─── Table detection ────────────────────────────────────────────────────────

interface DetectedTable {
  name: string;
  sheet: SheetProps;
  headerRow: number;
  endRow: number;
  startCol: number;
  endCol: number;
  headers: string[];
  confidence: number;
  grid: unknown[][];
}

/** Blocks of non-empty rows; each block's first row is its header row. */
function detectTables(sheet: SheetProps, grid: unknown[][]): DetectedTable[] {
  const tables: DetectedTable[] = [];
  let start = -1;
  for (let r = 0; r <= grid.length; r++) {
    const filled = r < grid.length && rowFilled(grid[r]);
    if (filled && start < 0) start = r;
    if (filled || start < 0) continue;
    const rows = grid.slice(start, r);
    let startCol = Infinity;
    let endCol = 0;
    for (const row of rows) {
      (row ?? []).forEach((cell, c) => {
        if (isEmptyCell(cell)) return;
        startCol = Math.min(startCol, c);
        endCol = Math.max(endCol, c + 1);
      });
    }
    const header = rows[0] ?? [];
    const headerCells = Array.from({ length: endCol - startCol }, (_v, k) => header[startCol + k]);
    const textHeaders = headerCells.filter((cell) => typeof cell === 'string' && cell.trim() !== '').length;
    const filledCells = rows.slice(1).reduce<number>((a, row) => a + headerCells.filter((_h, k) => !isEmptyCell(row?.[startCol + k])).length, 0);
    const density = rows.length > 1 ? filledCells / ((rows.length - 1) * headerCells.length) : 0;
    const confidence = Math.round((0.6 * (textHeaders / headerCells.length) + 0.4 * density) * 100) / 100;
    tables.push({
      name: tables.length ? `${sheet.title} (table ${tables.length + 1})` : sheet.title,
      sheet,
      headerRow: start,
      endRow: r,
      startCol,
      endCol,
      headers: uniqueHeaders(headerCells.map((cell, k) => (isEmptyCell(cell) ? indexToCol(startCol + k) : cellString(cell).trim()))),
      confidence,
      grid,
    });
    start = -1;
  }
  return tables;
}

function tableRange(table: DetectedTable): string {
  return `${quoteSheet(table.sheet.title)}!${boxToCells({ startRow: table.headerRow, endRow: table.endRow, startCol: table.startCol, endCol: table.endCol })}`;
}

async function scanTables(ctx: ToolContext, spreadsheetId: string, sheets: SheetProps[]): Promise<DetectedTable[]> {
  const grids = await mapLimit(sheets, 4, (sheet) => readGrid(ctx, spreadsheetId, sheet, { maxRows: TABLE_SCAN_ROWS }));
  return sheets.flatMap((sheet, k) => detectTables(sheet, grids[k] ?? []));
}

const listTables: GoogleTool = {
  name: 'list_tables',
  title: 'List tables',
  description:
    'Find the tables in a spreadsheet: blocks of filled rows whose first row is a header. Scans the first 1,000 rows of each sheet. Returns each table\'s name, sheet, A1 range and size.',
  inputSchema: schema(
    {
      spreadsheet_id: SPREADSHEET_ID,
      min_rows: i('Fewest data rows a table needs.', { default: 2 }),
      min_columns: i('Fewest columns a table needs.', { default: 1 }),
      min_confidence: n('Lowest confidence (0–1) a table needs: text headers and filled cells score high.', { default: 0.5 }),
    },
    ['spreadsheet_id'],
  ),
  annotations: READ,
  async run(args, ctx) {
    const id = sid(args);
    const info = await ctx.google.json<{ properties?: { title?: string }; sheets?: Array<{ properties: SheetProps }> }>({
      url: `${S}/${enc(id)}`,
      query: { fields: 'properties(title),sheets.properties' },
    });
    const sheets = (info?.sheets ?? []).map((sheet) => sheet.properties).filter((sheet) => (sheet.sheetType ?? 'GRID') === 'GRID');
    const minRows = int(args, 'min_rows', 'minRows') ?? 2;
    const minCols = int(args, 'min_columns', 'minColumns') ?? 1;
    const minConfidence = num(args, 'min_confidence', 'minConfidence') ?? 0.5;
    const tables = (await scanTables(ctx, id, sheets))
      .filter((t) => t.endRow - t.headerRow - 1 >= minRows && t.endCol - t.startCol >= minCols && t.confidence >= minConfidence)
      .map((t) => ({
        name: t.name,
        sheet_name: t.sheet.title,
        range: tableRange(t),
        rows: t.endRow - t.headerRow,
        columns: t.endCol - t.startCol,
        headers: t.headers,
        confidence: t.confidence,
        detected_type: 'header_table',
        display_url: `${sheetUrl(id, t.sheet.sheetId)}&range=${indexToCol(t.startCol)}${t.headerRow + 1}`,
      }));
    return { spreadsheet_name: info?.properties?.title ?? '', tables, display_url: sheetUrl(id) };
  },
};

const getTableSchema: GoogleTool = {
  name: 'get_table_schema',
  title: 'Get table schema',
  description: 'Column names, inferred types (TEXT, INTEGER, FLOAT, DATE, BOOLEAN) and empty-cell presence of one table. table_name is a list_tables name, a sheet name, or auto (the largest table).',
  inputSchema: schema(
    {
      spreadsheet_id: SPREADSHEET_ID,
      table_name: s('Table name from list_tables, a sheet name, or auto.'),
      sheet_name: s('Sheet to look in when the table name is ambiguous.'),
      sample_size: i('Data rows to sample for the types.', { default: 50 }),
    },
    ['spreadsheet_id', 'table_name'],
  ),
  annotations: READ,
  async run(args, ctx) {
    const id = sid(args);
    const tableName = reqStr(args, 'table_name', 'tableName').trim();
    const sheetName = str(args, 'sheet_name', 'sheetName');
    let sheets = (await sheetsOf(ctx, id)).filter((sheet) => (sheet.sheetType ?? 'GRID') === 'GRID');
    if (sheetName) {
      const sheet = findSheet(sheets, sheetName);
      if (!sheet) throw noSheet(sheetName, sheets);
      sheets = [sheet];
    } else if (tableName.toLowerCase() !== 'auto') {
      const sheet = findSheet(sheets, tableName.replace(/ \(table \d+\)$/, ''));
      if (sheet) sheets = [sheet];
    }
    const tables = await scanTables(ctx, id, sheets);
    const lower = tableName.toLowerCase();
    const table =
      lower === 'auto'
        ? [...tables].sort((a, b) => (b.endRow - b.headerRow) * (b.endCol - b.startCol) - (a.endRow - a.headerRow) * (a.endCol - a.startCol))[0]
        : (tables.find((t) => t.name.toLowerCase() === lower) ?? tables.find((t) => t.sheet.title.toLowerCase() === lower));
    if (!table) throw new ToolInputError(`No table "${tableName}". Tables: ${tables.map((t) => t.name).join(', ') || 'none found'}`);
    const sample = table.grid.slice(table.headerRow + 1, table.headerRow + 1 + Math.max(int(args, 'sample_size', 'sampleSize') ?? 50, 1));
    const columns = table.headers.map((name, k) => {
      const values = sample.map((row) => row?.[table.startCol + k]);
      return { name, type: inferType(values), position: k + 1, nullable: values.some(isEmptyCell), formula_pattern: null };
    });
    return {
      spreadsheet_id: id,
      table_name: table.name,
      sheet_name: table.sheet.title,
      range: tableRange(table),
      primary_key: '_row',
      columns: [{ name: '_row', type: 'INTEGER', position: -1, nullable: false, formula_pattern: null }, ...columns],
      row_count: table.endRow - table.headerRow - 1,
      has_header: true,
      display_url: sheetUrl(id, table.sheet.sheetId),
    };
  },
};

async function loadTable(ctx: ToolContext, spreadsheetId: string, name: string, render: string): Promise<SqlTable> {
  const sheets = await sheetsOf(ctx, spreadsheetId);
  const sheet = findSheet(sheets, name);
  if (!sheet) throw new ToolInputError(`No sheet named "${name}" to use as a table. The sheets are: ${sheets.map((x) => x.title).join(', ')}`);
  return sheetAsTable(sheet, await readGrid(ctx, spreadsheetId, sheet, { render }));
}

function rowRange(table: SqlTable, row: number): string {
  return joinA1(table.sheet.title, boxToCells({ startRow: row - 1, endRow: row, startCol: table.startCol, endCol: table.startCol + Math.max(table.headers.length, 1) }));
}

async function runInsert(ctx: ToolContext, id: string, table: SqlTable, stmt: Extract<Stmt, { kind: 'INSERT' }>, dryRun: boolean): Promise<number> {
  const fresh = !table.headers.length;
  if (fresh && !stmt.columns) throw new ToolInputError(`Sheet "${table.sheet.title}" has no header row: name the columns, INSERT INTO t (a, b) VALUES …`);
  const headers = fresh ? stmt.columns! : table.headers;
  const columns = (stmt.columns ?? headers).map((col) => (fresh ? headers.indexOf(col) : requireColumn(table, col)));
  if (columns.includes(-1)) throw new ToolInputError('_row cannot be inserted');
  const rows = stmt.rows.map((values, k) => {
    if (values.length !== columns.length) throw new ToolInputError(`VALUES row ${k + 1} has ${values.length} values for ${columns.length} columns`);
    const row = new Array<Cell>(headers.length).fill('');
    columns.forEach((col, j) => {
      row[col] = values[j] ?? '';
    });
    return row;
  });
  if (dryRun) return rows.length;
  const start = fresh ? 0 : table.startCol;
  const values = fresh ? [headers, ...rows] : rows;
  const range = joinA1(table.sheet.title, `${indexToCol(start)}${table.headerRow + 1}:${indexToCol(start + headers.length - 1)}`);
  await ctx.google.json({ method: 'POST', url: `${S}/${enc(id)}/values/${enc(range)}:append`, query: { valueInputOption: 'USER_ENTERED', insertDataOption: 'INSERT_ROWS' }, body: { values } });
  return rows.length;
}

async function runChange(ctx: ToolContext, id: string, table: SqlTable, stmt: Extract<Stmt, { kind: 'UPDATE' | 'DELETE' }>, opts: { dryRun: boolean; removeRows: boolean }): Promise<Row[]> {
  const matched = stmt.where ? table.rows.filter(compileExpr(table, stmt.where)) : table.rows;
  if (opts.dryRun || !matched.length) return matched;
  if (stmt.kind === 'UPDATE') {
    const set = stmt.set.map((s0) => ({ index: requireColumn(table, s0.col), value: s0.value ?? '' }));
    if (set.some((s0) => s0.index === -1)) throw new ToolInputError('_row cannot be updated');
    const data = matched.flatMap((row) => set.map((s0) => ({ range: joinA1(table.sheet.title, `${indexToCol(table.startCol + s0.index)}${row.row}`), values: [[s0.value]] })));
    await ctx.google.json({ method: 'POST', url: `${S}/${enc(id)}/values:batchUpdate`, body: { valueInputOption: 'USER_ENTERED', data } });
  } else if (opts.removeRows) {
    const numbers = matched.map((row) => row.row).sort((a, b) => b - a);
    const requests: Json[] = [];
    for (const n0 of numbers) {
      const last = requests[requests.length - 1]?.deleteDimension as { range: { startIndex: number } } | undefined;
      if (last && last.range.startIndex === n0) last.range.startIndex = n0 - 1;
      else requests.push({ deleteDimension: { range: { sheetId: table.sheet.sheetId, dimension: 'ROWS', startIndex: n0 - 1, endIndex: n0 } } });
    }
    await batchUpdate(ctx, id, requests);
  } else {
    await ctx.google.json({ method: 'POST', url: `${S}/${enc(id)}/values:batchClear`, body: { ranges: matched.map((row) => rowRange(table, row.row)) } });
  }
  return matched;
}

const executeSql: GoogleTool = {
  name: 'execute_sql',
  title: 'Run SQL on a sheet',
  description:
    'Run one SELECT, INSERT, UPDATE or DELETE on a sheet as a table: FROM "Sheet1". The first filled row is the header; columns are header names or letters, `_row` is the sheet row. Supports WHERE (=, !=, <, >, LIKE, IN, BETWEEN, IS NULL, AND, OR, NOT), GROUP BY with COUNT/SUM/AVG/MIN/MAX, ORDER BY, LIMIT/OFFSET. No joins or WITH.',
  inputSchema: schema(
    {
      spreadsheet_id: SPREADSHEET_ID,
      sql: s('One statement, such as SELECT Name, Amount FROM "Sales" WHERE Region = \'EU\' ORDER BY Amount DESC LIMIT 10.'),
      dry_run: b('Report what a write would change without changing it.', { default: false }),
      delete_method: s('DELETE: clear empties the rows; remove_rows deletes them and shifts the rows below up.', { enum: ['clear', 'remove_rows'], default: 'clear' }),
    },
    ['spreadsheet_id', 'sql'],
  ),
  annotations: DESTRUCTIVE,
  async run(args, ctx) {
    const id = sid(args);
    const stmt = new SqlParser(tokenize(reqStr(args, 'sql', 'query'))).parse();
    const table = await loadTable(ctx, id, stmt.table, 'UNFORMATTED_VALUE');
    const dryRun = flag(args, 'dry_run', 'dryRun') ?? false;
    const display = sheetUrl(id, table.sheet.sheetId);
    if (stmt.kind === 'SELECT') {
      const data = runSelect(table, stmt, false);
      return { successful: true, operation: 'SELECT', data, affected_rows: data.length, message: `Retrieved ${data.length} row${data.length === 1 ? '' : 's'}`, table_schema: resultSchema(data), display_url: display };
    }
    const prefix = dryRun ? 'Dry run: would have ' : '';
    if (stmt.kind === 'INSERT') {
      const count = await runInsert(ctx, id, table, stmt, dryRun);
      return { successful: true, operation: 'INSERT', data: [], affected_rows: count, message: `${prefix}inserted ${count} row${count === 1 ? '' : 's'} into "${table.sheet.title}"`, table_schema: [], display_url: display };
    }
    const removeRows = (str(args, 'delete_method', 'deleteMethod') ?? 'clear') === 'remove_rows';
    const matched = await runChange(ctx, id, table, stmt, { dryRun, removeRows });
    const verb = stmt.kind === 'UPDATE' ? 'updated' : removeRows ? 'deleted' : 'cleared';
    const data = matched.slice(0, 100).map((row) => ({ _row: row.row, ...Object.fromEntries(table.headers.map((h, k) => [h, row.cells[k] ?? null])) }));
    return { successful: true, operation: stmt.kind, data, affected_rows: matched.length, message: `${prefix}${verb} ${matched.length} row${matched.length === 1 ? '' : 's'} in "${table.sheet.title}"`, table_schema: [], display_url: display };
  },
};

const queryTable: GoogleTool = {
  name: 'query_table',
  title: 'Query a sheet with SQL',
  description:
    'Run a SELECT on a sheet as a table: SELECT cols FROM "Sheet1" WHERE … ORDER BY … LIMIT n. SELECT * adds `_row`, the sheet row number. Same SQL as execute_sql, read-only.',
  inputSchema: schema(
    {
      spreadsheet_id: SPREADSHEET_ID,
      sql: s('A SELECT statement; the table is the sheet name.'),
      include_formulas: b('Return formula text instead of computed values.', { default: false }),
    },
    ['spreadsheet_id', 'sql'],
  ),
  annotations: READ,
  async run(args, ctx) {
    const id = sid(args);
    const stmt = new SqlParser(tokenize(reqStr(args, 'sql', 'query'))).parse();
    if (stmt.kind !== 'SELECT') throw new ToolInputError('query_table runs SELECT only; use execute_sql to change data');
    const table = await loadTable(ctx, id, stmt.table, (flag(args, 'include_formulas', 'includeFormulas') ?? false) ? 'FORMULA' : 'UNFORMATTED_VALUE');
    const rows = runSelect(table, stmt, true);
    return { rows, table_schema: resultSchema(rows), display_url: sheetUrl(id, table.sheet.sheetId) };
  },
};

export const SHEETS_TOOLS: readonly GoogleTool[] = [
  valuesGet,
  valuesUpdate,
  batchGet,
  getBatchValues,
  updateValuesBatch,
  valuesAppend,
  clearValues,
  valuesBatchClear,
  batchClearByDataFilter,
  valuesBatchGetByDataFilter,
  batchUpdateByDataFilter,
  batchUpdateDeprecated,
  createGoogleSheet,
  sheetFromJson,
  getSpreadsheetInfo,
  getSheetNames,
  findWorksheetByTitle,
  getSpreadsheetByDataFilter,
  addSheet,
  deleteSheet,
  updateSheetProperties,
  updateSpreadsheetProperties,
  sheetsCopyTo,
  searchDeveloperMetadata,
  appendDimension,
  insertDimension,
  deleteDimension,
  insertOne('create_spreadsheet_row', 'ROWS'),
  insertOne('create_spreadsheet_column', 'COLUMNS'),
  autoResizeDimensions,
  updateDimensionProperties,
  formatCell,
  findReplace,
  sortRange,
  setBasicFilter,
  clearBasicFilter,
  setDataValidationRule,
  getDataValidationRules,
  getConditionalFormatRules,
  mutateConditionalFormatRules,
  createChart,
  updateChart,
  deleteChart,
  moveChart,
  listCharts,
  searchSpreadsheets,
  getDriveFileMetadata,
  moveSpreadsheetToFolder,
  exportDriveFile,
  exportSheetAsPdf,
  listDriveChanges,
  aggregateColumnData,
  lookupSpreadsheetRow,
  upsertRowsTool,
  listTables,
  getTableSchema,
  executeSql,
  queryTable,
];
