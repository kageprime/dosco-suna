/**
 * Markdown → Google Docs `documents.batchUpdate` requests, for the Markdown
 * tools of ./docs.ts.
 *
 * `marked` parses the Markdown as GFM. A single newline inside a paragraph
 * stays a line break (as in GitHub comments), because agents write
 * `**Owner:** …` lines one under the other. The output is native Docs
 * content: headings (HEADING_1–6), bold, italic, strikethrough, inline code
 * (monospace on gray), links, bulleted and numbered lists with nesting and
 * task markers (☐/☑), code blocks (monospace on gray), block quotes (indent and
 * a left bar), horizontal rules (a bottom border), inline images from public
 * http(s) URLs, and real tables (header row bold, column alignment kept).
 *
 * How the requests are built. Every block is inserted at the same index L, in
 * reverse document order: a block inserted later pushes the blocks already
 * there forward, so each block's requests depend only on L and its own size.
 * Each run of text blocks is one `insertText`; its paragraph and text styles are
 * reset, then set from offsets computed in UTF-16 code units (the unit of Docs
 * indexes and of a JavaScript string's length). Lists carry one leading tab per
 * nesting level; `createParagraphBullets` turns the tabs into nesting and
 * removes them, so it runs last for each run, list by list from the end. A
 * table is `insertTable` at L, then its cells are filled from the last to the
 * first, at indexes computed from the empty table's layout. Docs puts an empty
 * paragraph before every table; the text before a table is written into that
 * paragraph, so no blank line appears.
 *
 * Limits: Docs numbers every list from 1 and gives nested items the glyphs of
 * the outermost list's type; a list item's extra paragraphs become line breaks
 * in the item; a table with more than 20 columns becomes tab-separated text;
 * images must be public http(s) URLs Docs can fetch (PNG, JPEG or GIF).
 */
import { Lexer, getDefaults, type Token, type Tokens } from 'marked';
import { ToolInputError } from './tool';

type Json = Record<string, unknown>;

/** Where the content goes: a header, footer or footnote (`segmentId`) and a tab. */
export interface DocsTarget {
  tabId?: string;
  segmentId?: string;
}

/** The index the Markdown is inserted at and the paragraph found there. */
export interface InsertionPoint {
  index: number;
  /** The paragraph at `index` is empty and may take the last inserted block. */
  merge: boolean;
  /** The paragraph at `index` has a bullet, which inserted text would inherit. */
  bullet: boolean;
  /** Requests that must run first (a paragraph split). */
  pre: Json[];
}

export interface MarkdownOptions {
  /** False renders images as linked alt text (the retry after Docs refuses an image). */
  images: boolean;
  /** `attachment://<name>` → public image URL, from the tool's `image_assets`. */
  imageAssets?: ReadonlyMap<string, string>;
}

export interface MarkdownPlan {
  requests: Json[];
  warnings: string[];
}

const MAX_TABLE_COLUMNS = 20;
const MAX_NESTING_LEVEL = 8;
const MAX_IMAGE_URI_CHARS = 2000;

const pt = (magnitude: number) => ({ magnitude, unit: 'PT' });
const rgb = (hex: number) => ({ color: { rgbColor: { red: ((hex >> 16) & 255) / 255, green: ((hex >> 8) & 255) / 255, blue: (hex & 255) / 255 } } });
const border = (hex: number, width: number, padding: number) => ({ color: rgb(hex), width: pt(width), padding: pt(padding), dashStyle: 'SOLID' });

const CODE_BACKGROUND = rgb(0xf1f3f4);
const QUOTE_BAR = 0xdadce0;
const QUOTE_TEXT = rgb(0x5f6368);
const LINK_BLUE = rgb(0x1155cc);
const MONO = { fontFamily: 'Roboto Mono', weight: 400 };
const CODE_BLOCK_TEXT: Json = { weightedFontFamily: MONO, fontSize: pt(10) };

const PARAGRAPH_RESET =
  'namedStyleType,alignment,lineSpacing,indentStart,indentEnd,indentFirstLine,spaceAbove,spaceBelow,' +
  'borderTop,borderBottom,borderLeft,borderRight,borderBetween,shading,keepLinesTogether,keepWithNext';
const TEXT_RESET = 'bold,italic,underline,strikethrough,smallCaps,backgroundColor,foregroundColor,fontSize,weightedFontFamily,baselineOffset,link';

// ─── Inline text ────────────────────────────────────────────────────────────

interface InlineStyle {
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  code?: boolean;
  link?: string;
}

interface Span {
  start: number;
  end: number;
  style: InlineStyle;
}

const sameStyle = (a: InlineStyle, b: InlineStyle) =>
  a.bold === b.bold && a.italic === b.italic && a.strike === b.strike && a.code === b.code && a.link === b.link;

/**
 * Docs strips these on insert (and `\r`); a newline would start a paragraph,
 * so it becomes a line break (U+000B). Removing them first keeps every
 * computed index true.
 */
function clean(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\n/g, '\u000b')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000C-\u001F-]/g, '');
}

/** One paragraph's text, style spans and inline images. Offsets count an image as one index. */
class Rich {
  text = '';
  length = 0;
  readonly spans: Span[] = [];
  readonly images: Array<{ at: number; uri: string }> = [];

  add(raw: string, style: InlineStyle = {}): void {
    const text = clean(raw);
    if (!text) return;
    const last = this.spans[this.spans.length - 1];
    if (last && last.end === this.length && sameStyle(last.style, style)) last.end += text.length;
    else this.spans.push({ start: this.length, end: this.length + text.length, style });
    this.text += text;
    this.length += text.length;
  }

  image(uri: string): void {
    this.images.push({ at: this.length, uri });
    this.length += 1;
  }
}

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', trade: '™', hellip: '…',
  mdash: '—', ndash: '–', laquo: '«', raquo: '»', bull: '•', middot: '·', times: '×', deg: '°', euro: '€', pound: '£',
  rarr: '→', larr: '←', harr: '↔', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', check: '✓',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (match, body: string) => {
    if (body.startsWith('#')) {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[body] ?? match;
  });
}

/** Docs accepts web, mail and phone links; a relative link stays plain text. */
const linkUrl = (href: string): string | undefined => (/^(https?:|mailto:|tel:)/i.test(href.trim()) ? href.trim() : undefined);

const isLineBreakTag = (html: string) => /^<br\s*\/?>$/i.test(html.trim());
const isComment = (html: string) => /^<!--[\s\S]*-->$/.test(html.trim());

// ─── Blocks ─────────────────────────────────────────────────────────────────

interface ListRef {
  key: number;
  level: number;
  ordered: boolean;
}

interface Para {
  rich: Rich;
  heading: number;
  code: boolean;
  quote: number;
  rule: boolean;
  /** `item: false` is a list item's code block or quote: indented, no bullet. */
  list?: ListRef & { item: boolean };
  spaceBelow: boolean;
}

interface Table {
  rows: Rich[][];
  align: Array<'CENTER' | 'END' | null>;
}

type Block = { para: Para } | { table: Table };

interface Ctx {
  quote: number;
  list?: ListRef;
}

/** Walks `marked`'s tokens into Docs paragraphs and tables. */
class Converter {
  readonly blocks: Block[] = [];
  readonly warnings: string[] = [];
  private nextList = 0;

  constructor(private readonly opts: MarkdownOptions) {}

  private warn(message: string): void {
    if (!this.warnings.includes(message)) this.warnings.push(message);
  }

  private para(rich: Rich, ctx: Ctx, extra: Partial<Para> = {}): void {
    this.blocks.push({
      para: { rich, heading: 0, code: false, rule: false, quote: ctx.quote, spaceBelow: false, ...(ctx.list ? { list: { ...ctx.list, item: false } } : {}), ...extra },
    });
  }

  block(tokens: readonly Token[], ctx: Ctx): void {
    for (const token of tokens) {
      switch (token.type) {
        case 'heading': {
          const t = token as Tokens.Heading;
          this.para(this.inline(t.tokens), ctx, { heading: Math.min(Math.max(t.depth, 1), 6) });
          break;
        }
        case 'paragraph':
          this.para(this.inline((token as Tokens.Paragraph).tokens), ctx);
          break;
        case 'text': {
          const t = token as Tokens.Text;
          this.para(t.tokens?.length ? this.inline(t.tokens) : this.plain(decodeEntities(t.text)), ctx);
          break;
        }
        case 'code':
          this.code((token as Tokens.Code).text, ctx);
          break;
        case 'blockquote':
          this.block((token as Tokens.Blockquote).tokens, { ...ctx, quote: ctx.quote + 1 });
          break;
        case 'list':
          this.list(token as Tokens.List, ctx);
          break;
        case 'hr':
          this.para(new Rich(), ctx, { rule: true });
          break;
        case 'table':
          this.table(token as Tokens.Table);
          break;
        case 'html': {
          // Repeat until stable: one pass over `<!-<!---->-->` leaves a new comment opener behind.
          let html = (token as Tokens.HTML).text;
          for (let previous = ''; previous !== html; ) {
            previous = html;
            html = html.replace(/<!--[\s\S]*?-->/g, '');
          }
          html = html.trim();
          if (html && !isLineBreakTag(html)) this.para(this.plain(html), ctx);
          break;
        }
        case 'space':
        case 'def':
        case 'checkbox':
          break;
        default:
          if (typeof (token as { text?: unknown }).text === 'string') this.para(this.plain(decodeEntities((token as { text: string }).text)), ctx);
      }
    }
  }

  private plain(text: string): Rich {
    const rich = new Rich();
    rich.add(text);
    return rich;
  }

  private code(text: string, ctx: Ctx): void {
    // Inside a list, a leading tab would count as a nesting level.
    const body = ctx.list ? text.replace(/^\t+/, (tabs) => '    '.repeat(tabs.length)) : text;
    this.para(this.plain(body), ctx, { code: true });
  }

  private list(token: Tokens.List, ctx: Ctx): void {
    const parent = ctx.list;
    const ref: ListRef = parent
      ? { key: parent.key, level: Math.min(parent.level + 1, MAX_NESTING_LEVEL), ordered: parent.ordered }
      : { key: this.nextList++, level: 0, ordered: token.ordered };
    if (!parent && token.ordered && typeof token.start === 'number' && token.start > 1) {
      this.warn(`Google Docs numbers every list from 1: a list that started at ${token.start} starts at 1.`);
    }
    for (const item of token.items) this.item(item, { quote: ctx.quote, list: ref });
  }

  private item(item: Tokens.ListItem, ctx: Ctx & { list: ListRef }): void {
    const rich = new Rich();
    if (item.task) rich.add(item.checked ? '☑ ' : '☐ ');
    const tokens = item.tokens.filter((t) => t.type !== 'space' && t.type !== 'checkbox');
    let index = 0;
    // The item's leading text is its paragraph; more text joins it as line breaks.
    while (index < tokens.length && (tokens[index]!.type === 'text' || tokens[index]!.type === 'paragraph')) {
      const t = tokens[index] as Tokens.Text | Tokens.Paragraph;
      if (index > 0) rich.add('\n');
      if (t.tokens?.length) this.inlineInto(rich, t.tokens, {});
      else rich.add(decodeEntities(t.text));
      index++;
    }
    this.blocks.push({ para: { rich, heading: 0, code: false, rule: false, quote: ctx.quote, spaceBelow: false, list: { ...ctx.list, item: true } } });
    this.block(tokens.slice(index), ctx);
  }

  private table(token: Tokens.Table): void {
    const width = token.header.length;
    const source = [token.header, ...token.rows];
    if (width > MAX_TABLE_COLUMNS) {
      this.warn(`A table has ${width} columns; Google Docs allows ${MAX_TABLE_COLUMNS}, so it is tab-separated text.`);
      source.forEach((row, r) => {
        const rich = new Rich();
        for (let j = 0; j < width; j++) {
          if (j) rich.add('\t');
          this.inlineInto(rich, row[j]?.tokens ?? [], r === 0 ? { bold: true } : {});
        }
        this.para(rich, { quote: 0 });
      });
      return;
    }
    const rows = source.map((row) => Array.from({ length: width }, (_, j) => this.inline(row[j]?.tokens ?? [])));
    this.blocks.push({ table: { rows, align: token.align.map((a) => (a === 'center' ? 'CENTER' : a === 'right' ? 'END' : null)) } });
  }

  private inline(tokens: readonly Token[]): Rich {
    const rich = new Rich();
    this.inlineInto(rich, tokens, {});
    return rich;
  }

  private inlineInto(rich: Rich, tokens: readonly Token[], style: InlineStyle): void {
    for (const token of tokens) {
      switch (token.type) {
        case 'text': {
          const t = token as Tokens.Text;
          if (t.tokens?.length) this.inlineInto(rich, t.tokens, style);
          else rich.add(decodeEntities(t.text), style);
          break;
        }
        case 'escape':
          rich.add((token as Tokens.Escape).text, style);
          break;
        case 'strong':
          this.inlineInto(rich, (token as Tokens.Strong).tokens, { ...style, bold: true });
          break;
        case 'em':
          this.inlineInto(rich, (token as Tokens.Em).tokens, { ...style, italic: true });
          break;
        case 'del':
          this.inlineInto(rich, (token as Tokens.Del).tokens, { ...style, strike: true });
          break;
        case 'codespan':
          rich.add((token as Tokens.Codespan).text, { ...style, code: true });
          break;
        case 'br':
          rich.add('\n', style);
          break;
        case 'link': {
          const t = token as Tokens.Link;
          const url = linkUrl(t.href);
          this.inlineInto(rich, t.tokens, url ? { ...style, link: url } : style);
          break;
        }
        case 'image':
          this.image(rich, token as Tokens.Image, style);
          break;
        case 'html': {
          const html = (token as Tokens.HTML).text;
          if (isLineBreakTag(html)) rich.add('\n', style);
          else if (!isComment(html)) rich.add(html, style);
          break;
        }
        case 'checkbox':
          break;
        default:
          if (typeof (token as { text?: unknown }).text === 'string') rich.add(decodeEntities((token as { text: string }).text), style);
      }
    }
  }

  private image(rich: Rich, token: Tokens.Image, style: InlineStyle): void {
    const href = (token.href ?? '').trim();
    const alt = decodeEntities(token.text ?? '');
    let uri: string | undefined;
    const asset = /^attachment:\/\/(.+)$/i.exec(href);
    if (asset) {
      uri = this.opts.imageAssets?.get(asset[1]!);
      if (!uri) this.warn(`Image "${asset[1]}" has no public https url in image_assets: its alt text was inserted instead.`);
    } else if (/^https?:\/\//i.test(href)) {
      uri = href;
    } else {
      this.warn(`Image "${href.slice(0, 80)}" is not an http(s) URL: its alt text was inserted instead.`);
    }
    if (uri && uri.length > MAX_IMAGE_URI_CHARS) {
      this.warn(`An image URL is longer than ${MAX_IMAGE_URI_CHARS} characters, which Docs refuses: it became a link.`);
    } else if (uri && this.opts.images) {
      rich.image(uri);
      return;
    }
    rich.add(alt || uri || href, uri ? { ...style, link: uri } : style);
  }

  /** Space below every non-heading paragraph, and below each list's last paragraph only. */
  finish(): Block[] {
    this.blocks.forEach((block, index) => {
      if (!('para' in block) || block.para.heading) return;
      const { para } = block;
      const next = this.blocks[index + 1];
      para.spaceBelow = !para.list || !(next && 'para' in next && next.para.list?.key === para.list.key);
    });
    return this.blocks;
  }
}

// ─── Requests ───────────────────────────────────────────────────────────────

interface Placed {
  para: Para;
  /** Offset of the paragraph in its run, before bullets remove the tabs. */
  start: number;
  /** Leading tabs (list nesting level). */
  tabs: number;
  /** Offset after the paragraph's newline. */
  end: number;
}

function paragraphStyle(para: Para): Json | null {
  const style: Json = {};
  if (para.heading) style.namedStyleType = `HEADING_${para.heading}`;
  if (para.spaceBelow) style.spaceBelow = pt(8);
  if (para.code) style.shading = { backgroundColor: CODE_BACKGROUND };
  if (para.quote && !para.list) {
    style.indentStart = pt(18 * para.quote);
    style.indentFirstLine = pt(18 * para.quote);
    style.borderLeft = border(QUOTE_BAR, 3, 9);
  }
  if (para.rule) style.borderBottom = border(QUOTE_BAR, 1, 1);
  return Object.keys(style).length ? style : null;
}

function textStyle(style: InlineStyle): Json | null {
  const out: Json = {};
  if (style.bold) out.bold = true;
  if (style.italic) out.italic = true;
  if (style.strike) out.strikethrough = true;
  if (style.code) {
    out.weightedFontFamily = MONO;
    out.backgroundColor = CODE_BACKGROUND;
  }
  if (style.link) {
    out.link = { url: style.link };
    out.foregroundColor = LINK_BLUE;
    out.underline = true;
  }
  return Object.keys(out).length ? out : null;
}

/** Emits the requests for the blocks, last block first, all at one index. */
class Emitter {
  readonly requests: Json[] = [];
  private merge: boolean;
  private bullet: boolean;
  private readonly seg: Json;

  constructor(private readonly at: number, point: InsertionPoint, target: DocsTarget) {
    this.merge = point.merge;
    this.bullet = point.bullet;
    this.seg = { ...(target.segmentId ? { segmentId: target.segmentId } : {}), ...(target.tabId ? { tabId: target.tabId } : {}) };
  }

  private loc(index: number): Json {
    return { index, ...this.seg };
  }

  private range(startIndex: number, endIndex: number): Json {
    return { startIndex, endIndex, ...this.seg };
  }

  private textStyleRequest(start: number, end: number, style: Json | null): void {
    if (style && end > start) this.requests.push({ updateTextStyle: { range: this.range(start, end), textStyle: style, fields: Object.keys(style).join(',') } });
  }

  /** Clear what inserted text inherits from the paragraph it was inserted into. */
  private reset(start: number, end: number, paragraph: Json = { namedStyleType: 'NORMAL_TEXT' }, text: Json = {}): void {
    if (this.bullet) this.requests.push({ deleteParagraphBullets: { range: this.range(start, end) } });
    this.requests.push({ updateParagraphStyle: { range: this.range(start, end), paragraphStyle: paragraph, fields: PARAGRAPH_RESET } });
    this.requests.push({ updateTextStyle: { range: this.range(start, end), textStyle: text, fields: TEXT_RESET } });
  }

  text(paras: readonly Para[]): void {
    const L = this.at;
    let offset = 0;
    let text = '';
    const placed: Placed[] = paras.map((para) => {
      const tabs = para.list ? para.list.level : 0;
      const start = offset;
      offset += tabs + para.rich.length + 1;
      text += '\t'.repeat(tabs) + para.rich.text + '\n';
      return { para, start, tabs, end: offset };
    });
    // The last newline is the empty paragraph already at L.
    if (this.merge) text = text.slice(0, -1);
    if (text) this.requests.push({ insertText: { text, location: this.loc(L) } });
    for (const p of placed) {
      for (const image of p.para.rich.images) this.requests.push({ insertInlineImage: { uri: image.uri, location: this.loc(L + p.start + p.tabs + image.at) } });
    }
    this.reset(L, L + offset);
    this.paragraphStyles(placed);
    for (const p of placed) {
      const base = L + p.start + p.tabs;
      this.textStyleRequest(base, base + p.para.rich.length, p.para.code ? CODE_BLOCK_TEXT : p.para.quote ? { foregroundColor: QUOTE_TEXT } : null);
      for (const span of p.para.rich.spans) this.textStyleRequest(base + span.start, base + span.end, textStyle(span.style));
    }
    this.bullets(placed);
    this.merge = false;
    this.bullet = Boolean(paras[0]?.list?.item);
  }

  /** One request per run of neighbouring paragraphs with the same style. */
  private paragraphStyles(placed: readonly Placed[]): void {
    const L = this.at;
    let runStart = 0;
    for (let index = 1; index <= placed.length; index++) {
      const style = paragraphStyle(placed[runStart]!.para);
      if (index < placed.length && JSON.stringify(paragraphStyle(placed[index]!.para)) === JSON.stringify(style)) continue;
      if (style) {
        this.requests.push({
          updateParagraphStyle: { range: this.range(L + placed[runStart]!.start, L + placed[index - 1]!.end), paragraphStyle: style, fields: Object.keys(style).join(',') },
        });
      }
      runStart = index;
    }
  }

  /** Lists from the last to the first: removing one list's tabs leaves earlier offsets true. */
  private bullets(placed: readonly Placed[]): void {
    const L = this.at;
    const lists = new Map<number, Placed[]>();
    for (const p of placed) {
      if (!p.para.list) continue;
      const group = lists.get(p.para.list.key) ?? [];
      group.push(p);
      lists.set(p.para.list.key, group);
    }
    for (const group of [...lists.values()].reverse()) {
      const first = group[0]!;
      const last = group[group.length - 1]!;
      this.requests.push({
        createParagraphBullets: {
          range: this.range(L + first.start, L + last.end),
          bulletPreset: first.para.list!.ordered ? 'NUMBERED_DECIMAL_ALPHA_ROMAN' : 'BULLET_DISC_CIRCLE_SQUARE',
        },
      });
      // Code blocks and quotes in an item keep the item's indent but lose the bullet.
      let removed = 0;
      for (const p of group) {
        if (!p.para.list!.item) this.requests.push({ deleteParagraphBullets: { range: this.range(L + p.start - removed, L + p.start - removed + 1) } });
        removed += p.tabs;
      }
    }
  }

  table(table: Table): void {
    const L = this.at;
    const rows = table.rows.length;
    const columns = table.rows[0]?.length ?? 0;
    if (!rows || !columns) return;
    this.requests.push({ insertTable: { rows, columns, location: this.loc(L) } });
    // The table starts at L + 1; cell (i, j) of the empty table holds its paragraph here.
    const emptyCell = (i: number, j: number) => L + 1 + 3 + i * (1 + 2 * columns) + 2 * j;
    for (let i = rows - 1; i >= 0; i--) {
      for (let j = columns - 1; j >= 0; j--) {
        const cell = table.rows[i]![j]!;
        if (cell.text) this.requests.push({ insertText: { text: cell.text, location: this.loc(emptyCell(i, j)) } });
        for (const image of cell.images) this.requests.push({ insertInlineImage: { uri: image.uri, location: this.loc(emptyCell(i, j) + image.at) } });
      }
    }
    // The empty paragraph Docs adds before the table takes the style of the paragraph that was at L.
    this.reset(L, L + 1);
    let before = 0;
    for (let i = 0; i < rows; i++) {
      for (let j = 0; j < columns; j++) {
        const cell = table.rows[i]![j]!;
        const start = emptyCell(i, j) + before;
        before += cell.length;
        const align = table.align[j];
        this.reset(start, start + cell.length + 1, { namedStyleType: 'NORMAL_TEXT', ...(align ? { alignment: align } : {}) }, i === 0 ? { bold: true } : {});
        for (const span of cell.spans) this.textStyleRequest(start + span.start, start + span.end, textStyle(span.style));
      }
    }
    this.merge = true;
    this.bullet = false;
  }
}

/**
 * The requests that insert `markdown` at `point`. Runs of text blocks and
 * tables are emitted last first; see the module comment.
 */
export function markdownRequests(markdown: string, point: InsertionPoint, target: DocsTarget, opts: MarkdownOptions): MarkdownPlan {
  const converter = new Converter(opts);
  converter.block(Lexer.lex(markdown, { ...getDefaults(), gfm: true, breaks: true }), { quote: 0 });
  const units: Array<Para[] | Table> = [];
  for (const block of converter.finish()) {
    if ('table' in block) units.push(block.table);
    else {
      const last = units[units.length - 1];
      if (Array.isArray(last)) last.push(block.para);
      else units.push([block.para]);
    }
  }
  const emitter = new Emitter(point.index, point, target);
  for (const unit of units.reverse()) {
    if (Array.isArray(unit)) emitter.text(unit);
    else emitter.table(unit);
  }
  return { requests: [...point.pre, ...emitter.requests], warnings: converter.warnings };
}

// ─── Document structure ─────────────────────────────────────────────────────

/** A `StructuralElement` of the Docs API, as far as these tools read it. */
export interface DocElement {
  startIndex?: number;
  endIndex?: number;
  paragraph?: { elements?: Json[]; bullet?: { listId?: string; nestingLevel?: number }; paragraphStyle?: Json };
  table?: { rows?: number; columns?: number; tableRows?: Array<{ tableCells?: Array<{ startIndex?: number; endIndex?: number; content?: DocElement[] }> }> };
  tableOfContents?: { content?: DocElement[] };
  sectionBreak?: Json;
}

/** The end index of a segment: the last element's end. */
export function segmentEnd(content: readonly DocElement[]): number {
  return content[content.length - 1]?.endIndex ?? 1;
}

/** The paragraph holding `index`, searched into table cells. */
export function paragraphAt(content: readonly DocElement[], index: number): DocElement | null {
  for (const element of content) {
    const start = element.startIndex ?? 0;
    const end = element.endIndex ?? 0;
    if (index < start || index >= end) continue;
    if (element.paragraph) return element;
    for (const row of element.table?.tableRows ?? []) {
      for (const cell of row.tableCells ?? []) {
        const found = paragraphAt(cell.content ?? [], index);
        if (found) return found;
      }
    }
    if (element.tableOfContents) return paragraphAt(element.tableOfContents.content ?? [], index);
  }
  return null;
}

/**
 * Where Markdown inserted at `index` starts. Inside a paragraph's text the
 * paragraph is split first, so the Markdown starts on a paragraph of its own.
 */
export function insertionPoint(content: readonly DocElement[], index: number, target: DocsTarget): InsertionPoint {
  const paragraph = paragraphAt(content, index);
  if (!paragraph) {
    throw new ToolInputError(`index ${index} is not inside a paragraph (it may be a table boundary). get_document_end_index lists the paragraph ranges.`);
  }
  const start = paragraph.startIndex ?? 0;
  const end = paragraph.endIndex ?? start + 1;
  const bullet = Boolean(paragraph.paragraph?.bullet);
  if (end - start <= 1) return { index, merge: true, bullet, pre: [] };
  if (index === start) return { index, merge: false, bullet, pre: [] };
  const location = { index, ...(target.segmentId ? { segmentId: target.segmentId } : {}), ...(target.tabId ? { tabId: target.tabId } : {}) };
  return { index: index + 1, merge: index === end - 1, bullet, pre: [{ insertText: { text: '\n', location } }] };
}
