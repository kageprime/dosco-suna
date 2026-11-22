import { ToolInputError } from './tool';
export type Json = Record<string, unknown>;
export type Cell = string | number | boolean | null;
export interface SheetProps {
  sheetId: number;
  title: string;
  index: number;
  hidden?: boolean;
  sheetType?: string;
  gridProperties?: { rowCount?: number; columnCount?: number; frozenRowCount?: number };
}

// ─── SQL over a sheet (execute_sql, query_table) ────────────────────────────
//
// A sheet is a table: its first filled row is the header row, the rows below
// are the data. Columns are named by header (case-insensitive) or by letter;
// `_row` is the sheet row number. Supported: SELECT [DISTINCT] … FROM … WHERE
// … GROUP BY … ORDER BY … LIMIT … OFFSET, COUNT/SUM/AVG/MIN/MAX, INSERT INTO …
// VALUES, UPDATE … SET … WHERE, DELETE FROM … WHERE. No joins, no WITH.

type Tok = { k: 'id' | 'qid' | 'kw' | 'str' | 'num' | 'op'; v: string };
type Operand = { col: string; quoted: boolean } | { lit: Cell };
type Expr =
  | { t: 'and' | 'or'; a: Expr; b: Expr }
  | { t: 'not'; a: Expr }
  | { t: 'cmp'; op: string; l: Operand; r: Operand }
  | { t: 'like'; l: Operand; pattern: string; neg: boolean }
  | { t: 'in'; l: Operand; list: Cell[]; neg: boolean }
  | { t: 'null'; l: Operand; neg: boolean }
  | { t: 'between'; l: Operand; lo: Cell; hi: Cell; neg: boolean };
interface SelectItem {
  agg?: string;
  col: string;
  alias?: string;
}
export type Stmt =
  | { kind: 'SELECT'; table: string; items: SelectItem[] | '*'; distinct: boolean; where?: Expr; groupBy: string[]; orderBy: Array<{ col: string; desc: boolean }>; limit?: number; offset?: number }
  | { kind: 'INSERT'; table: string; columns?: string[]; rows: Cell[][] }
  | { kind: 'UPDATE'; table: string; set: Array<{ col: string; value: Cell }>; where?: Expr }
  | { kind: 'DELETE'; table: string; where?: Expr };

const AGGREGATES = new Set(['COUNT', 'SUM', 'AVG', 'MIN', 'MAX']);
const SQL_KEYWORDS = new Set([
  'SELECT', 'DISTINCT', 'FROM', 'WHERE', 'AND', 'OR', 'NOT', 'GROUP', 'ORDER', 'BY', 'ASC', 'DESC', 'LIMIT', 'OFFSET', 'INSERT', 'INTO', 'VALUES',
  'UPDATE', 'SET', 'DELETE', 'LIKE', 'IN', 'IS', 'NULL', 'BETWEEN', 'AS', 'TRUE', 'FALSE', 'WITH', ...AGGREGATES,
]);

export function tokenize(sql: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i]!;
    const rest = sql.slice(i);
    if (/\s/.test(ch)) {
      i++;
    } else if (ch === "'") {
      let value = '';
      i++;
      while (i < sql.length && !(sql[i] === "'" && sql[i + 1] !== "'")) {
        value += sql[i] === "'" ? "'" : sql[i];
        i += sql[i] === "'" ? 2 : 1;
      }
      if (i >= sql.length) throw new ToolInputError('sql has an unclosed string');
      out.push({ k: 'str', v: value });
      i++;
    } else if (ch === '"' || ch === '`' || ch === '[') {
      const end = sql.indexOf(ch === '[' ? ']' : ch, i + 1);
      if (end < 0) throw new ToolInputError(`sql has an unclosed ${ch}`);
      out.push({ k: 'qid', v: sql.slice(i + 1, end) });
      i = end + 1;
    } else if (/^\d/.test(rest) || /^\.\d/.test(rest)) {
      const match = /^(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?/.exec(rest)!;
      out.push({ k: 'num', v: match[0] });
      i += match[0].length;
    } else if (/^[A-Za-z_]/.test(rest)) {
      const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest)![0];
      out.push(SQL_KEYWORDS.has(word.toUpperCase()) ? { k: 'kw', v: word.toUpperCase() } : { k: 'id', v: word });
      i += word.length;
    } else {
      const op = /^(<=|>=|<>|!=|==|[=<>(),*;.+-])/.exec(rest);
      if (!op) throw new ToolInputError(`sql has an unexpected character "${ch}"`);
      out.push({ k: 'op', v: op[0] });
      i += op[0].length;
    }
  }
  return out;
}

export class SqlParser {
  private i = 0;
  constructor(private readonly toks: Tok[]) {}

  private peek(): Tok | undefined {
    return this.toks[this.i];
  }
  private next(): Tok {
    const tok = this.toks[this.i++];
    if (!tok) throw new ToolInputError('sql ends too early');
    return tok;
  }
  private isKw(value: string): boolean {
    const tok = this.peek();
    return tok?.k === 'kw' && tok.v === value;
  }
  private eatKw(value: string): boolean {
    if (!this.isKw(value)) return false;
    this.i++;
    return true;
  }
  private eatOp(value: string): boolean {
    const tok = this.peek();
    if (tok?.k !== 'op' || tok.v !== value) return false;
    this.i++;
    return true;
  }
  private expectKw(value: string): void {
    if (!this.eatKw(value)) throw new ToolInputError(`sql: expected ${value} near "${this.peek()?.v ?? 'the end'}"`);
  }
  private expectOp(value: string): void {
    if (!this.eatOp(value)) throw new ToolInputError(`sql: expected "${value}" near "${this.peek()?.v ?? 'the end'}"`);
  }
  private ident(): string {
    const tok = this.next();
    if (tok.k !== 'id' && tok.k !== 'qid' && tok.k !== 'str' && !(tok.k === 'kw' && AGGREGATES.has(tok.v))) throw new ToolInputError(`sql: expected a name, got "${tok.v}"`);
    let name = tok.v;
    while (this.eatOp('.')) name = this.ident();
    return name;
  }
  private count(): number {
    const tok = this.next();
    if (tok.k !== 'num' || !/^\d+$/.test(tok.v)) throw new ToolInputError(`sql: expected a whole number, got "${tok.v}"`);
    return Number(tok.v);
  }
  private literal(): Cell {
    const tok = this.next();
    if (tok.k === 'str' || tok.k === 'qid') return tok.v;
    if (tok.k === 'num') return Number(tok.v);
    if (tok.k === 'op' && tok.v === '-') return -Number(this.next().v);
    if (tok.k === 'kw' && tok.v === 'NULL') return null;
    if (tok.k === 'kw' && (tok.v === 'TRUE' || tok.v === 'FALSE')) return tok.v === 'TRUE';
    throw new ToolInputError(`sql: expected a value, got "${tok.v}"`);
  }
  private operand(): Operand {
    const tok = this.peek();
    if (tok?.k === 'id' || tok?.k === 'qid') return { col: this.ident(), quoted: tok.k === 'qid' };
    return { lit: this.literal() };
  }
  private alias(): string | undefined {
    if (this.eatKw('AS')) return this.ident();
    const tok = this.peek();
    return tok?.k === 'id' || tok?.k === 'qid' ? this.ident() : undefined;
  }

  parse(): Stmt {
    if (this.isKw('WITH')) throw new ToolInputError('WITH queries are not supported. Send one SELECT, INSERT, UPDATE or DELETE.');
    let stmt: Stmt;
    if (this.eatKw('SELECT')) stmt = this.select();
    else if (this.eatKw('INSERT')) stmt = this.insert();
    else if (this.eatKw('UPDATE')) stmt = this.update();
    else if (this.eatKw('DELETE')) {
      this.expectKw('FROM');
      const table = this.ident();
      stmt = { kind: 'DELETE', table, where: this.eatKw('WHERE') ? this.expr() : undefined };
    } else throw new ToolInputError('sql must start with SELECT, INSERT, UPDATE or DELETE');
    this.eatOp(';');
    if (this.peek()) throw new ToolInputError(`sql: unexpected "${this.peek()!.v}"`);
    return stmt;
  }

  private select(): Stmt {
    const distinct = this.eatKw('DISTINCT');
    let items: SelectItem[] | '*' = '*';
    if (!this.eatOp('*')) {
      items = [];
      do items.push(this.selectItem());
      while (this.eatOp(','));
    }
    this.expectKw('FROM');
    const table = this.ident();
    const where = this.eatKw('WHERE') ? this.expr() : undefined;
    const groupBy: string[] = [];
    if (this.eatKw('GROUP')) {
      this.expectKw('BY');
      do groupBy.push(this.ident());
      while (this.eatOp(','));
    }
    const orderBy: Array<{ col: string; desc: boolean }> = [];
    if (this.eatKw('ORDER')) {
      this.expectKw('BY');
      do {
        const col = this.ident();
        const desc = this.eatKw('DESC');
        if (!desc) this.eatKw('ASC');
        orderBy.push({ col, desc });
      } while (this.eatOp(','));
    }
    let limit: number | undefined;
    let offset: number | undefined;
    if (this.eatKw('LIMIT')) {
      limit = this.count();
      if (this.eatKw('OFFSET')) offset = this.count();
      else if (this.eatOp(',')) [offset, limit] = [limit, this.count()];
    }
    return { kind: 'SELECT', table, items, distinct, where, groupBy, orderBy, limit, offset };
  }

  private selectItem(): SelectItem {
    const tok = this.peek();
    if (tok?.k === 'kw' && AGGREGATES.has(tok.v) && this.toks[this.i + 1]?.v === '(') {
      this.i += 2;
      this.eatKw('DISTINCT');
      const col = this.eatOp('*') ? '*' : this.ident();
      this.expectOp(')');
      return { agg: tok.v, col, alias: this.alias() };
    }
    return { col: this.ident(), alias: this.alias() };
  }

  private insert(): Stmt {
    this.expectKw('INTO');
    const table = this.ident();
    let columns: string[] | undefined;
    if (this.eatOp('(')) {
      columns = [];
      do columns.push(this.ident());
      while (this.eatOp(','));
      this.expectOp(')');
    }
    this.expectKw('VALUES');
    const rows: Cell[][] = [];
    do {
      this.expectOp('(');
      const row: Cell[] = [];
      do row.push(this.literal());
      while (this.eatOp(','));
      this.expectOp(')');
      rows.push(row);
    } while (this.eatOp(','));
    return { kind: 'INSERT', table, columns, rows };
  }

  private update(): Stmt {
    const table = this.ident();
    this.expectKw('SET');
    const set: Array<{ col: string; value: Cell }> = [];
    do {
      const col = this.ident();
      this.expectOp('=');
      set.push({ col, value: this.literal() });
    } while (this.eatOp(','));
    return { kind: 'UPDATE', table, set, where: this.eatKw('WHERE') ? this.expr() : undefined };
  }

  private expr(): Expr {
    let left = this.conjunction();
    while (this.eatKw('OR')) left = { t: 'or', a: left, b: this.conjunction() };
    return left;
  }
  private conjunction(): Expr {
    let left = this.negation();
    while (this.eatKw('AND')) left = { t: 'and', a: left, b: this.negation() };
    return left;
  }
  private negation(): Expr {
    return this.eatKw('NOT') ? { t: 'not', a: this.negation() } : this.predicate();
  }
  private predicate(): Expr {
    if (this.eatOp('(')) {
      const inner = this.expr();
      this.expectOp(')');
      return inner;
    }
    const l = this.operand();
    if (this.eatKw('IS')) {
      const neg = this.eatKw('NOT');
      this.expectKw('NULL');
      return { t: 'null', l, neg };
    }
    const neg = this.eatKw('NOT');
    if (this.eatKw('LIKE')) return { t: 'like', l, pattern: cellString(this.literal()), neg };
    if (this.eatKw('IN')) {
      this.expectOp('(');
      const list: Cell[] = [];
      do list.push(this.literal());
      while (this.eatOp(','));
      this.expectOp(')');
      return { t: 'in', l, list, neg };
    }
    if (this.eatKw('BETWEEN')) {
      const lo = this.literal();
      this.expectKw('AND');
      return { t: 'between', l, lo, hi: this.literal(), neg };
    }
    if (neg) throw new ToolInputError('sql: NOT must be followed by LIKE, IN or BETWEEN here');
    const op = this.next();
    if (op.k !== 'op' || !['=', '==', '!=', '<>', '<', '<=', '>', '>='].includes(op.v)) throw new ToolInputError(`sql: expected a comparison, got "${op.v}"`);
    return { t: 'cmp', op: op.v === '==' ? '=' : op.v === '<>' ? '!=' : op.v, l, r: this.operand() };
  }
}

export interface SqlTable {
  sheet: SheetProps;
  headers: string[];
  headerRow: number;
  startCol: number;
  rows: Array<{ row: number; cells: unknown[] }>;
}

/** The sheet as one table: the first filled row is the header; empty rows are skipped. */
export function sheetAsTable(sheet: SheetProps, grid: unknown[][]): SqlTable {
  const headerRow = grid.findIndex(rowFilled);
  if (headerRow < 0) return { sheet, headers: [], headerRow: 0, startCol: 0, rows: [] };
  const header = grid[headerRow]!;
  const startCol = header.findIndex((cell) => !isEmptyCell(cell));
  let width = 0;
  for (const row of grid.slice(headerRow)) {
    (row ?? []).forEach((cell, c) => {
      if (!isEmptyCell(cell)) width = Math.max(width, c + 1);
    });
  }
  const headers = uniqueHeaders(Array.from({ length: width - startCol }, (_v, k) => (isEmptyCell(header[startCol + k]) ? indexToCol(startCol + k) : cellString(header[startCol + k]).trim())));
  const rows = grid
    .slice(headerRow + 1)
    .map((row, k) => ({ row: headerRow + k + 2, cells: headers.map((_h, j) => row?.[startCol + j] ?? null) }))
    .filter((row) => row.cells.some((cell) => !isEmptyCell(cell)));
  return { sheet, headers, headerRow, startCol, rows };
}

/** Column index in the table, -1 for _row, undefined when unknown. */
function sqlColumn(table: SqlTable, name: string): number | undefined {
  if (name.toLowerCase() === '_row') return -1;
  const byHeader = table.headers.findIndex((header) => header.toLowerCase() === name.toLowerCase());
  if (byHeader >= 0) return byHeader;
  if (/^[A-Za-z]{1,3}$/.test(name)) {
    const index = colToIndex(name) - table.startCol;
    if (index >= 0 && index < table.headers.length) return index;
  }
  return undefined;
}

export function requireColumn(table: SqlTable, name: string): number {
  const index = sqlColumn(table, name);
  if (index === undefined) throw new ToolInputError(`Unknown column "${name}". The columns are: ${table.headers.join(', ') || 'none'} (and _row)`);
  return index;
}

export type Row = { row: number; cells: unknown[] };
const cellAt = (row: Row, index: number): unknown => (index === -1 ? row.row : row.cells[index]);

function sqlNumber(value: unknown): number | null {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && /^\s*-?(\d+\.?\d*|\.\d+)\s*$/.test(value)) return Number(value);
  return null;
}

function sqlCompare(a: unknown, b: unknown): number {
  const na = sqlNumber(a);
  const nb = sqlNumber(b);
  if (na !== null && nb !== null) return na - nb;
  const sa = cellString(a);
  const sb = cellString(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

function compileOperand(table: SqlTable, operand: Operand): (row: Row) => unknown {
  if ('lit' in operand) return () => operand.lit;
  const index = sqlColumn(table, operand.col);
  if (index === undefined) {
    // "Active" in WHERE Status = "Active" is a string to most people, not a column.
    if (operand.quoted) return () => operand.col;
    requireColumn(table, operand.col);
  }
  return (row) => cellAt(row, index!);
}

function likeRegex(pattern: string): RegExp {
  const body = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.');
  return new RegExp(`^${body}$`, 'is');
}

export function compileExpr(table: SqlTable, expr: Expr): (row: Row) => boolean {
  switch (expr.t) {
    case 'and': {
      const [a, b] = [compileExpr(table, expr.a), compileExpr(table, expr.b)];
      return (row) => a(row) && b(row);
    }
    case 'or': {
      const [a, b] = [compileExpr(table, expr.a), compileExpr(table, expr.b)];
      return (row) => a(row) || b(row);
    }
    case 'not': {
      const a = compileExpr(table, expr.a);
      return (row) => !a(row);
    }
    case 'null': {
      const l = compileOperand(table, expr.l);
      return (row) => isEmptyCell(l(row)) !== expr.neg;
    }
    case 'like': {
      const l = compileOperand(table, expr.l);
      const re = likeRegex(expr.pattern);
      return (row) => re.test(cellString(l(row))) !== expr.neg;
    }
    case 'in': {
      const l = compileOperand(table, expr.l);
      return (row) => expr.list.some((value) => sqlCompare(l(row), value) === 0) !== expr.neg;
    }
    case 'between': {
      const l = compileOperand(table, expr.l);
      return (row) => (!isEmptyCell(l(row)) && sqlCompare(l(row), expr.lo) >= 0 && sqlCompare(l(row), expr.hi) <= 0) !== expr.neg;
    }
    default: {
      const [l, r] = [compileOperand(table, expr.l), compileOperand(table, expr.r)];
      const test: Record<string, (d: number) => boolean> = { '=': (d) => d === 0, '!=': (d) => d !== 0, '<': (d) => d < 0, '<=': (d) => d <= 0, '>': (d) => d > 0, '>=': (d) => d >= 0 };
      return (row) => {
        const [a, b] = [l(row), r(row)];
        if (a === null || a === undefined || b === null || b === undefined) return false;
        return test[expr.op]!(sqlCompare(a, b));
      };
    }
  }
}

function aggregate(fn: string, values: unknown[]): unknown {
  if (fn === 'COUNT') return values.length;
  const numbers = values.map(sqlNumber).filter((v): v is number => v !== null);
  if (fn === 'SUM') return numbers.reduce((a, v) => a + v, 0);
  if (fn === 'AVG') return numbers.length ? numbers.reduce((a, v) => a + v, 0) / numbers.length : null;
  const pool = numbers.length === values.length ? numbers : values;
  if (!pool.length) return null;
  return [...pool].sort(sqlCompare)[fn === 'MIN' ? 0 : pool.length - 1];
}

function sortRows<T>(rows: T[], keys: Array<{ get: (row: T) => unknown; desc: boolean }>): T[] {
  return [...rows].sort((a, b) => {
    for (const key of keys) {
      const d = sqlCompare(key.get(a), key.get(b));
      if (d) return key.desc ? -d : d;
    }
    return 0;
  });
}

function page<T>(rows: T[], offset?: number, limit?: number): T[] {
  const start = offset ?? 0;
  return rows.slice(start, limit !== undefined ? start + limit : undefined);
}

function distinctRows(rows: Json[]): Json[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = JSON.stringify(row);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function runSelect(table: SqlTable, stmt: Extract<Stmt, { kind: 'SELECT' }>, withRowNumber: boolean): Json[] {
  const rows = stmt.where ? table.rows.filter(compileExpr(table, stmt.where)) : table.rows;
  const items = stmt.items === '*' ? null : stmt.items;
  if (items?.some((item) => item.agg) || stmt.groupBy.length) {
    const keys = stmt.groupBy.map((name) => requireColumn(table, name));
    const groups = new Map<string, Row[]>();
    for (const row of rows) {
      const key = JSON.stringify(keys.map((k) => cellAt(row, k) ?? null));
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    if (!groups.size && !keys.length) groups.set('[]', []);
    const out = [...groups.values()].map((group) => {
      const record: Json = {};
      for (const item of items ?? stmt.groupBy.map((col) => ({ col }) as SelectItem)) {
        const name = item.alias ?? (item.agg ? `${item.agg}(${item.col})` : item.col);
        if (!item.agg) record[name] = cellAt(group[0] ?? { row: 0, cells: [] }, requireColumn(table, item.col)) ?? null;
        else if (item.col === '*') record[name] = group.length;
        else {
          const index = requireColumn(table, item.col);
          record[name] = aggregate(item.agg, group.map((row) => cellAt(row, index)).filter((v) => !isEmptyCell(v)));
        }
      }
      return record;
    });
    const sorted = sortRows(out, stmt.orderBy.map((o) => ({ get: (r: Json) => r[Object.keys(r).find((k) => k.toLowerCase() === o.col.toLowerCase()) ?? o.col], desc: o.desc })));
    return page(stmt.distinct ? distinctRows(sorted) : sorted, stmt.offset, stmt.limit);
  }
  const aliasOf = new Map((items ?? []).filter((item) => item.alias).map((item) => [item.alias!.toLowerCase(), item.col]));
  const sorted = sortRows(rows, stmt.orderBy.map((o) => {
    const index = requireColumn(table, aliasOf.get(o.col.toLowerCase()) ?? o.col);
    return { get: (row: Row) => cellAt(row, index), desc: o.desc };
  }));
  const columns = items
    ? items.map((item) => ({ name: item.alias ?? item.col, index: requireColumn(table, item.col) }))
    : [...(withRowNumber ? [{ name: '_row', index: -1 }] : []), ...table.headers.map((name, index) => ({ name, index }))];
  const projected = sorted.map((row) => Object.fromEntries(columns.map((c) => [c.name, cellAt(row, c.index) ?? null])));
  return page(stmt.distinct ? distinctRows(projected) : projected, stmt.offset, stmt.limit);
}

export function resultSchema(rows: Json[]): Array<{ name: string; type: string }> {
  const names = rows.length ? Object.keys(rows[0]!) : [];
  return names.map((name) => ({ name, type: inferType(rows.map((row) => row[name])) }));
}


export function colToIndex(letters: string): number {
  let value = 0;
  for (const ch of letters.toUpperCase()) value = value * 26 + (ch.charCodeAt(0) - 64);
  return value - 1;
}

export function indexToCol(index: number): string {
  let value = index + 1;
  let out = '';
  while (value > 0) {
    const rest = (value - 1) % 26;
    out = String.fromCharCode(65 + rest) + out;
    value = Math.floor((value - 1) / 26);
  }
  return out;
}

export function isEmptyCell(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
}

export function cellString(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
}

/** A number from a cell: numbers as they are, and text such as "$1,200.50" or "(30)". */
export function cellNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const cleaned = value.trim().replace(/^\((.*)\)$/, '-$1').replace(/[$€£¥,\s%]/g, '');
  if (cleaned === '' || !/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(cleaned)) return null;
  return Number(cleaned);
}

export function rowFilled(row: unknown[] | undefined): boolean {
  return !!row && row.some((cell) => !isEmptyCell(cell));
}

export function uniqueHeaders(headers: string[]): string[] {
  const seen = new Map<string, number>();
  return headers.map((header) => {
    const count = (seen.get(header.toLowerCase()) ?? 0) + 1;
    seen.set(header.toLowerCase(), count);
    return count > 1 ? `${header}_${count}` : header;
  });
}

export function inferType(values: unknown[]): string {
  const filled = values.filter((value) => !isEmptyCell(value));
  if (!filled.length) return 'UNKNOWN';
  if (filled.every((value) => typeof value === 'boolean')) return 'BOOLEAN';
  if (filled.every((value) => typeof value === 'number')) return filled.every((value) => Number.isInteger(value)) ? 'INTEGER' : 'FLOAT';
  if (filled.every((value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}|^\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}/.test(value) && !Number.isNaN(Date.parse(value.replace(/\./g, '/'))))) return 'DATE';
  return 'TEXT';
}
