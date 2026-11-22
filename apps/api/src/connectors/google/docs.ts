/**
 * Kortix Google Docs MCP server tools. Names and arguments follow Composio's
 * Google Docs toolkit (`get_document_plaintext`, `create_document_markdown`,
 * `replace_all_text`, …); see ./tool.ts.
 *
 * Scopes: `documents` for the Docs API, `drive` for search, copy, export,
 * metadata, permissions and uploads, `spreadsheets` for the two Sheets reads
 * Composio put in this toolkit. A tool that takes a document id also takes a
 * full Docs URL.
 *
 * The Markdown tools (create_document_markdown, update_document_markdown,
 * update_document_section_markdown) convert Markdown to native Docs content
 * with batchUpdate requests: ./docs-markdown.ts. batchUpdate keeps the
 * document id, works on one tab, and inserts at an index, which a Drive
 * HTML import cannot do.
 */
import { GoogleApiError } from './client';
import { fileOutput, resolveFile, FILE_ITEM_SCHEMA, type FileInput } from './files';
import { insertionPoint, markdownRequests, segmentEnd, type DocElement, type DocsTarget } from './docs-markdown';
import {
  DESTRUCTIVE,
  READ,
  ToolInputError,
  WRITE,
  anyObj,
  arr,
  b,
  i,
  optBool,
  optInt,
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

const DOCS = 'https://docs.googleapis.com/v1/documents';
const DRIVE = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';
const DOC_MIME = 'application/vnd.google-apps.document';
const SHORTCUT_MIME = 'application/vnd.google-apps.shortcut';
/** Requests per batchUpdate call; a longer list runs as consecutive calls. */
const MAX_REQUESTS_PER_BATCH = 500;
const TEXT_CHUNK_CHARS = 50_000;
const SIMPLE_UPLOAD_MAX_BYTES = 5 * 1024 * 1024;
const MAX_TABLE_SIZE = 20;

type Json = Record<string, unknown>;

const enc = encodeURIComponent;
const docUrl = (id: string) => `https://docs.google.com/document/d/${id}/edit`;
const obj = (value: unknown): Json | undefined => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : undefined);
const num = (value: unknown): number | undefined => {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? Math.trunc(n) : undefined;
};

const ID_KEYS = ['document_id', 'documentId', 'id', 'doc_id', 'docId'];

/** A document id, or the id inside a Docs or Drive URL. */
function docIdArg(args: Json, ...keys: string[]): string {
  const raw = reqStr(args, ...(keys.length ? keys : ID_KEYS)).trim();
  return /\/d\/([A-Za-z0-9_-]{10,})/.exec(raw)?.[1] ?? raw;
}

function reqInt(args: Json, ...keys: string[]): number {
  for (const key of keys) {
    const value = num(args[key]);
    if (value !== undefined) return value;
  }
  throw new ToolInputError(`${keys[0]} is required and must be an integer`);
}

function reqObj(args: Json, ...keys: string[]): Json {
  for (const key of keys) {
    const value = optObj(args, key);
    if (value) return value;
  }
  throw new ToolInputError(`${keys[0]} is required and must be an object`);
}

const withTab = (tabId: string | undefined, value: Json = {}): Json => (tabId ? { ...value, tabId } : value);

// ─── batchUpdate ────────────────────────────────────────────────────────────

interface BatchResult {
  replies: unknown[];
  writeControl?: Json;
}

/** A batchUpdate failed after earlier calls of the same list were applied. */
class BatchFailure extends GoogleApiError {
  readonly applied: number;
  constructor(cause: GoogleApiError, applied: number, total: number) {
    super(cause.status, applied ? `${cause.message} (${applied} of ${total} request batches were already applied)` : cause.message, cause.reason);
    this.applied = applied;
  }
}

async function batchUpdate(ctx: ToolContext, id: string, requests: readonly Json[], writeControl?: Json): Promise<BatchResult> {
  const replies: unknown[] = [];
  let control: Json | undefined;
  const total = Math.ceil(requests.length / MAX_REQUESTS_PER_BATCH);
  for (let index = 0; index < total; index++) {
    const slice = requests.slice(index * MAX_REQUESTS_PER_BATCH, (index + 1) * MAX_REQUESTS_PER_BATCH);
    try {
      const result = await ctx.google.json<{ replies?: unknown[]; writeControl?: Json }>({
        method: 'POST',
        url: `${DOCS}/${enc(id)}:batchUpdate`,
        body: { requests: slice, ...(writeControl && index === 0 ? { writeControl } : {}) },
      });
      replies.push(...(result?.replies ?? []));
      control = result?.writeControl ?? control;
    } catch (error) {
      if (error instanceof GoogleApiError && total > 1) throw new BatchFailure(error, index, total);
      throw error;
    }
  }
  return { replies, writeControl: control };
}

const camelOut = (id: string, r: BatchResult): Json => ({ documentId: id, replies: r.replies, writeControl: r.writeControl, display_url: docUrl(id) });
const snakeOut = (id: string, r: BatchResult): Json => ({ document_id: id, replies: r.replies, write_control: r.writeControl, display_url: docUrl(id) });

interface BatchToolDef {
  name: string;
  title: string;
  description: string;
  props: Record<string, Record<string, unknown>>;
  required: string[];
  annotations?: ToolAnnotations;
  requests(args: Json): Json[];
  output?: (id: string, result: BatchResult, args: Json) => Json;
}

/** A tool that is one batchUpdate built from its arguments. */
function batchTool(def: BatchToolDef): GoogleTool {
  return {
    name: def.name,
    title: def.title,
    description: def.description,
    inputSchema: schema(def.props, def.required),
    annotations: def.annotations ?? WRITE,
    async run(args, ctx) {
      const id = docIdArg(args);
      const result = await batchUpdate(ctx, id, def.requests(args));
      return (def.output ?? camelOut)(id, result, args);
    },
  };
}

// ─── Reading documents ──────────────────────────────────────────────────────

interface Segment {
  content?: DocElement[];
}

interface ListDef {
  listProperties?: { nestingLevels?: Array<{ glyphType?: string; glyphSymbol?: string; startNumber?: number }> };
}

/** The content of one tab (or of the legacy first-tab fields). */
interface TabContent {
  body?: Segment;
  headers?: Record<string, Segment>;
  footers?: Record<string, Segment>;
  footnotes?: Record<string, Segment>;
  lists?: Record<string, ListDef>;
  inlineObjects?: Json;
  positionedObjects?: Json;
}

interface DocTab {
  tabProperties?: { tabId?: string; title?: string; index?: number };
  documentTab?: TabContent;
  childTabs?: DocTab[];
}

interface DocResource extends TabContent {
  documentId?: string;
  title?: string;
  revisionId?: string;
  suggestionsViewMode?: string;
  tabs?: DocTab[];
  documentStyle?: { defaultHeaderId?: string; defaultFooterId?: string };
}

function getDoc(ctx: ToolContext, id: string, includeTabs: boolean, fields?: string): Promise<DocResource> {
  return ctx.google.json<DocResource>({ url: `${DOCS}/${enc(id)}`, query: { includeTabsContent: includeTabs || undefined, fields } });
}

function flattenTabs(tabs: readonly DocTab[] = []): DocTab[] {
  return tabs.flatMap((tab) => [tab, ...flattenTabs(tab.childTabs)]);
}

/** The tab's content, or the first tab's when `tabId` is omitted. */
async function tabContent(ctx: ToolContext, id: string, tabId: string | undefined): Promise<TabContent> {
  if (!tabId) return getDoc(ctx, id, false);
  const doc = await getDoc(ctx, id, true);
  const tab = flattenTabs(doc.tabs).find((t) => t.tabProperties?.tabId === tabId);
  if (!tab) throw new ToolInputError(`tab ${tabId} is not in the document. get_document_by_id with includeTabsContent lists tabs[].tabProperties.tabId.`);
  return tab.documentTab ?? {};
}

function segmentContent(tab: TabContent, segmentId: string | undefined): DocElement[] {
  if (!segmentId) return tab.body?.content ?? [];
  const segment = tab.headers?.[segmentId] ?? tab.footers?.[segmentId] ?? tab.footnotes?.[segmentId];
  if (!segment) throw new ToolInputError(`segment ${segmentId} is not a header, footer or footnote of the document`);
  return segment.content ?? [];
}

/** Every paragraph, in document order, including those in table cells. */
function paragraphs(content: readonly DocElement[]): DocElement[] {
  return content.flatMap((element) => {
    if (element.paragraph) return [element];
    if (element.tableOfContents) return paragraphs(element.tableOfContents.content ?? []);
    return (element.table?.tableRows ?? []).flatMap((row) => (row.tableCells ?? []).flatMap((cell) => paragraphs(cell.content ?? [])));
  });
}

/** The cell's first paragraph start of the table that starts at `tableStart`. */
function tableCellIndex(content: readonly DocElement[], tableStart: number, row: number, column: number): { start: number; end: number } {
  const table = content.find((e) => e.table && e.startIndex === tableStart);
  if (!table?.table) throw new ToolInputError(`no table starts at index ${tableStart}. get_document_by_id shows each table's startIndex.`);
  const cell = table.table.tableRows?.[row]?.tableCells?.[column];
  if (!cell) throw new ToolInputError(`the table has no cell at row ${row}, column ${column}`);
  const first = cell.content?.[0];
  const start = first?.startIndex ?? (cell.startIndex ?? tableStart) + 1;
  return { start, end: cell.endIndex ?? start + 1 };
}

// ─── Plain text ─────────────────────────────────────────────────────────────

const ROMAN: Array<[number, string]> = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']];

function numberLabel(n: number, glyph: string): string {
  if (glyph.includes('ALPHA')) {
    let label = '';
    for (let k = n; k > 0; k = Math.floor((k - 1) / 26)) label = String.fromCharCode(97 + ((k - 1) % 26)) + label;
    return glyph.startsWith('UPPER') ? label.toUpperCase() : label;
  }
  if (glyph.includes('ROMAN')) {
    let label = '';
    let k = n;
    for (const [value, numeral] of ROMAN) for (; k >= value; k -= value) label += numeral;
    return glyph.startsWith('UPPER') ? label.toUpperCase() : label;
  }
  return glyph === 'ZERO_DECIMAL' ? String(n).padStart(2, '0') : String(n);
}

/** A tab rendered as text: paragraphs, numbered and bulleted lists, tables. */
class PlainText {
  images = 0;
  readonly skipped = new Set<string>();
  private readonly counters = new Map<string, number[]>();

  constructor(
    private readonly lists: Record<string, ListDef>,
    private readonly opts: { tables: boolean; cell: string; row: string },
  ) {}

  content(elements: readonly DocElement[] = []): string {
    let out = '';
    for (const element of elements) {
      if (element.paragraph) out += `${this.paragraph(element.paragraph)}\n`;
      else if (element.table && this.opts.tables) out += `${this.table(element.table)}\n`;
      else if (element.tableOfContents) out += this.content(element.tableOfContents.content);
    }
    return out;
  }

  private paragraph(paragraph: NonNullable<DocElement['paragraph']>): string {
    const text = (paragraph.elements ?? []).map((element) => this.element(element)).join('').replace(/\n$/, '').replace(/\u000b/g, '\n');
    const bullet = paragraph.bullet;
    if (!bullet) return text;
    const level = bullet.nestingLevel ?? 0;
    return `${'  '.repeat(level)}${this.marker(bullet.listId ?? '', level)} ${text}`;
  }

  private element(element: Json): string {
    const run = obj(element.textRun);
    if (run) return typeof run.content === 'string' ? run.content : '';
    const person = obj(obj(element.person)?.personProperties);
    if (person) return String(person.name ?? person.email ?? '');
    const link = obj(obj(element.richLink)?.richLinkProperties);
    if (link) return String(link.title ?? link.uri ?? '');
    const footnote = obj(element.footnoteReference);
    if (footnote) return `[${String(footnote.footnoteNumber ?? '*')}]`;
    if (element.horizontalRule) return '---';
    const date = obj(obj(element.dateElement)?.dateElementProperties);
    if (date) return String(date.displayText ?? '');
    if (element.inlineObjectElement) this.images++;
    else if (element.equation) this.skipped.add('equations');
    return '';
  }

  private marker(listId: string, level: number): string {
    const def = this.lists[listId]?.listProperties?.nestingLevels?.[level];
    const counts = this.counters.get(listId) ?? [];
    counts.length = level + 1;
    counts[level] = (counts[level] ?? (def?.startNumber ?? 1) - 1) + 1;
    this.counters.set(listId, counts);
    const glyph = def?.glyphType;
    if (!glyph || glyph === 'GLYPH_TYPE_UNSPECIFIED' || glyph === 'NONE' || def?.glyphSymbol) return '-';
    return `${numberLabel(counts[level], glyph)}.`;
  }

  private table(table: NonNullable<DocElement['table']>): string {
    return (table.tableRows ?? [])
      .map((row) => (row.tableCells ?? []).map((cell) => this.content(cell.content).replace(/\n+$/, '').replace(/\n/g, ' ')).join(this.opts.cell))
      .join(this.opts.row);
  }
}

function renderTab(tab: TabContent, args: Json, warnings: string[]): string {
  const renderer = new PlainText(tab.lists ?? {}, {
    tables: optBool(args, 'include_tables', true),
    cell: typeof args.table_cell_delimiter === 'string' ? args.table_cell_delimiter : '\t',
    row: typeof args.table_row_delimiter === 'string' ? args.table_row_delimiter : '\n',
  });
  let text = renderer.content(tab.body?.content);
  const sections: Array<[string, string, Record<string, Segment> | undefined]> = [
    ['include_headers', 'Headers', tab.headers],
    ['include_footers', 'Footers', tab.footers],
    ['include_footnotes', 'Footnotes', tab.footnotes],
  ];
  for (const [flag, label, segments] of sections) {
    if (!optBool(args, flag, false) || !segments || !Object.keys(segments).length) continue;
    text += `\n--- ${label} ---\n${Object.values(segments).map((segment) => renderer.content(segment.content).trim()).filter(Boolean).join('\n')}\n`;
  }
  if (renderer.images) warnings.push(`${renderer.images} inline image(s) are not in the text.`);
  const positioned = Object.keys(tab.positionedObjects ?? {}).length;
  if (positioned) warnings.push(`${positioned} positioned object(s) are not in the text.`);
  for (const kind of renderer.skipped) warnings.push(`${kind} are not in the text.`);
  return text.replace(/\n+$/, '');
}

// ─── Markdown writing ───────────────────────────────────────────────────────

type Placement = { mode: 'replace' } | { mode: 'append' } | { mode: 'at'; start: number; end?: number };

interface MarkdownWrite extends BatchResult {
  warnings: string[];
  notes: string[];
}

/** `attachment://<name>` targets from `image_assets` entries that carry a public https URL. */
function imageAssets(args: Json): Map<string, string> {
  const assets = new Map<string, string>();
  for (const entry of Array.isArray(args.image_assets) ? args.image_assets : []) {
    const asset = obj(entry);
    if (!asset) continue;
    const file = obj(asset.file) ?? {};
    const name = [asset.name, file.name].find((v): v is string => typeof v === 'string' && v.trim() !== '');
    const url = [asset.url, file.url, file.s3url].find((v): v is string => typeof v === 'string' && /^https:\/\//i.test(v));
    if (!name || !url) continue;
    assets.set(name, url);
    assets.set(name.replace(/\.[a-z0-9]+$/i, ''), url);
  }
  return assets;
}

const isImageError = (error: unknown) => error instanceof GoogleApiError && /image/i.test(error.message);

async function writeMarkdown(
  ctx: ToolContext,
  id: string,
  markdown: string,
  target: DocsTarget,
  placement: Placement,
  assets: ReadonlyMap<string, string>,
  images = true,
): Promise<MarkdownWrite> {
  const notes: string[] = [];
  let content = (await tabContent(ctx, id, target.tabId)).body?.content ?? [];
  const remove = async (start: number, end: number) => {
    await batchUpdate(ctx, id, [{ deleteContentRange: { range: withTab(target.tabId, { startIndex: start, endIndex: end }) } }]);
    content = (await tabContent(ctx, id, target.tabId)).body?.content ?? [];
  };
  const last = segmentEnd(content) - 1;
  let index = last;
  if (placement.mode === 'replace') {
    if (last > 1) await remove(1, last);
    index = 1;
  } else if (placement.mode === 'at') {
    index = Math.max(1, placement.start);
    if (index > last) {
      notes.push(`start_index ${placement.start} is at or past the end of the document; the content went to the end (index ${last}).`);
      index = last;
    }
    const end = placement.end === undefined ? undefined : Math.min(placement.end, last);
    if (end !== undefined && end > index) await remove(index, end);
  }
  const plan = markdownRequests(markdown, insertionPoint(content, index, target), target, { images, imageAssets: assets });
  try {
    const result = await batchUpdate(ctx, id, plan.requests);
    return { ...result, warnings: plan.warnings, notes };
  } catch (error) {
    if (!images || !isImageError(error) || !plan.requests.some((r) => 'insertInlineImage' in r)) throw error;
    const applied = error instanceof BatchFailure ? error.applied : 0;
    if (applied > 0 && placement.mode !== 'replace') throw error;
    // Nothing of the failed list was applied, or a full replace can start over.
    const retry = await writeMarkdown(ctx, id, markdown, target, placement.mode === 'at' ? { mode: 'at', start: placement.start } : placement, assets, false);
    retry.warnings.unshift(`Google Docs could not insert an image (${(error as Error).message}); every image is a link to its URL instead.`);
    return { ...retry, notes: [...notes, ...retry.notes] };
  }
}

function markdownArg(args: Json, keys: string[]): string {
  for (const key of keys) if (typeof args[key] === 'string') return args[key] as string;
  return '';
}

// ─── Create and read ────────────────────────────────────────────────────────

/** Insert long text in chunks, last chunk first, all at `index`. */
function textInserts(text: string, index: number, target: DocsTarget = {}): Json[] {
  const chunks: string[] = [];
  for (let start = 0; start < text.length; ) {
    let end = Math.min(start + TEXT_CHUNK_CHARS, text.length);
    // Never split a surrogate pair.
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
    chunks.push(text.slice(start, end));
    start = end;
  }
  const location = { index, ...(target.segmentId ? { segmentId: target.segmentId } : {}), ...(target.tabId ? { tabId: target.tabId } : {}) };
  return chunks.reverse().map((chunk) => ({ insertText: { text: chunk, location } }));
}

async function createDoc(ctx: ToolContext, title: string): Promise<DocResource & { documentId: string }> {
  const doc = await ctx.google.json<DocResource>({ method: 'POST', url: DOCS, body: { title } });
  if (!doc?.documentId) throw new Error('Google Docs created no document');
  return doc as DocResource & { documentId: string };
}

const createDocument: GoogleTool = {
  name: 'create_document',
  title: 'Create document',
  description: 'Create a Google Doc with a title and optional plain text. Returns the document id, URL and styles. For formatted content use create_document_markdown.',
  inputSchema: schema({ title: s('Document title, also its Drive file name.'), text: s('Plain text to put in the document.') }, ['title']),
  annotations: WRITE,
  async run(args, ctx) {
    const doc = await createDoc(ctx, reqStr(args, 'title', 'name'));
    const id = doc.documentId;
    const text = typeof args.text === 'string' ? args.text : '';
    const result = text ? await batchUpdate(ctx, id, textInserts(text, 1)) : null;
    const { body: _body, tabs: _tabs, ...meta } = doc;
    const revisionId = (result?.writeControl?.requiredRevisionId as string | undefined) ?? doc.revisionId;
    return { ...meta, revisionId, documentUrl: docUrl(id), display_url: docUrl(id) };
  },
};

const createDocument2: GoogleTool = {
  name: 'create_document2',
  title: 'Create blank document',
  description: 'Create an empty Google Doc. Deprecated: create_document does the same and takes initial text.',
  inputSchema: schema({ title: s('Document title.') }, ['title']),
  annotations: WRITE,
  async run(args, ctx) {
    const doc = await createDoc(ctx, reqStr(args, 'title', 'name'));
    return { title: doc.title, documentId: doc.documentId, revisionId: doc.revisionId, document_url: docUrl(doc.documentId) };
  },
};

const IMAGE_ASSET_SCHEMA = {
  type: 'object',
  properties: {
    name: s('The name Markdown uses: ![alt](attachment://<name>).'),
    url: s('Public https URL of the image.'),
    file: { type: 'object', description: '{name, mimetype, url}. Docs fetches images from a public URL, so the file needs `url`.' },
  },
};

const createDocumentMarkdown: GoogleTool = {
  name: 'create_document_markdown',
  title: 'Create document from Markdown',
  description:
    'Create a Google Doc from Markdown. Headings, bold, italic, strikethrough, inline code, links, nested bulleted and numbered lists, task items, ' +
    'code blocks, quotes, horizontal rules, tables and public http(s) images become native Docs formatting. A single newline is a line break.',
  inputSchema: schema(
    {
      title: s('Document title.'),
      markdown_text: s('The content as Markdown. `content` is an alias.', { default: '' }),
      image_assets: arr(IMAGE_ASSET_SCHEMA, 'Images that Markdown references as ![alt](attachment://<name>). Each needs a public https url.'),
    },
    ['title'],
  ),
  annotations: WRITE,
  async run(args, ctx) {
    const doc = await createDoc(ctx, reqStr(args, 'title', 'name'));
    const id = doc.documentId;
    const markdown = markdownArg(args, ['markdown_text', 'content', 'markdown', 'text']);
    let written: MarkdownWrite | null = null;
    if (markdown.trim()) {
      const assets = imageAssets(args);
      try {
        written = await writeMarkdown(ctx, id, markdown, {}, { mode: 'append' }, assets);
      } catch (error) {
        // A partly written new document is rewritten whole, without images.
        if (!(error instanceof BatchFailure) || !isImageError(error)) throw error;
        written = await writeMarkdown(ctx, id, markdown, {}, { mode: 'replace' }, assets, false);
        written.warnings.unshift('Google Docs could not insert an image; every image is a link to its URL instead.');
      }
    }
    const tabs = await getDoc(ctx, id, true, 'revisionId,tabs(tabProperties)');
    const tabIds = flattenTabs(tabs.tabs).map((t) => t.tabProperties?.tabId).filter((t): t is string => Boolean(t));
    return {
      documentId: id,
      title: doc.title,
      revisionId: tabs.revisionId ?? doc.revisionId,
      suggestionsViewMode: doc.suggestionsViewMode,
      display_url: docUrl(id),
      tab_ids: tabIds,
      default_tab_id: tabIds[0],
      request_count: written ? written.replies.length : 0,
      ...(written?.warnings.length ? { warnings: written.warnings } : {}),
    };
  },
};

const getDocumentById: GoogleTool = {
  name: 'get_document_by_id',
  title: 'Get document',
  description: 'Read a Google Doc as Docs API JSON: structure, indexes, styles, lists and tabs. For readable text use get_document_plaintext.',
  inputSchema: schema(
    {
      id: s('Document id or Docs URL.'),
      includeTabsContent: b('Return every tab with its content in `tabs`; otherwise the first tab is in `body`.', { default: false }),
    },
    ['id'],
  ),
  annotations: READ,
  async run(args, ctx) {
    const id = docIdArg(args, 'id', 'document_id', 'documentId');
    const doc = await getDoc(ctx, id, optBool(args, 'includeTabsContent', optBool(args, 'include_tabs_content', false)));
    return { ...doc, display_url: docUrl(id), document_url: docUrl(id) };
  },
};

const getDocumentPlaintext: GoogleTool = {
  name: 'get_document_plaintext',
  title: 'Get document text',
  description: 'Read a Google Doc as plain text: paragraphs, numbered and bulleted lists, and tables (tab-separated cells). Optionally headers, footers, footnotes and every tab.',
  inputSchema: schema(
    {
      document_id: s('Document id or Docs URL. `id` is an alias.'),
      include_tables: b('Include tables.', { default: true }),
      include_headers: b('Append header text.', { default: false }),
      include_footers: b('Append footer text.', { default: false }),
      include_footnotes: b('Append footnote text.', { default: false }),
      include_tabs_content: b('Render every tab, not only the first.', { default: false }),
      tab_ids: strs('With include_tabs_content, only these tabs (child tabs included).'),
      table_cell_delimiter: s('Text between table cells.', { default: '\t' }),
      table_row_delimiter: s('Text between table rows.', { default: '\n' }),
    },
    ['document_id'],
  ),
  annotations: READ,
  async run(args, ctx) {
    const id = docIdArg(args);
    const allTabs = optBool(args, 'include_tabs_content', false);
    const doc = await getDoc(ctx, id, allTabs);
    const warnings: string[] = [];
    let plain: string;
    if (allTabs) {
      const wanted = strList(args, 'tab_ids');
      const tabs = flattenTabs(doc.tabs).filter((t) => !wanted.length || wanted.includes(t.tabProperties?.tabId ?? ''));
      for (const missing of wanted.filter((w) => !tabs.some((t) => t.tabProperties?.tabId === w))) warnings.push(`Tab ${missing} is not in the document.`);
      const rendered = tabs.map((t) => ({ title: t.tabProperties?.title ?? '', text: renderTab(t.documentTab ?? {}, args, warnings) }));
      plain = rendered.length === 1 ? rendered[0]!.text : rendered.map((r) => `=== ${r.title} ===\n${r.text}`).join('\n\n');
    } else {
      plain = renderTab(doc, args, warnings);
    }
    return { document_id: id, title: doc.title ?? '', plain_text: plain, display_url: docUrl(id), warnings };
  },
};

const getDocumentEndIndex: GoogleTool = {
  name: 'get_document_end_index',
  title: 'Get document end index',
  description:
    'The end index of the body (or a header, footer or footnote) and every paragraph range. Insert at end_index - 1 to append; insert inside a paragraph range.',
  inputSchema: schema(
    { document_id: s('Document id or Docs URL.'), tab_id: s('Tab id; the first tab when omitted.'), segment_id: s('Header, footer or footnote id; the body when omitted.') },
    ['document_id'],
  ),
  annotations: READ,
  async run(args, ctx) {
    const id = docIdArg(args);
    const tabId = optStr(args, 'tab_id', 'tabId');
    const segmentId = optStr(args, 'segment_id', 'segmentId');
    const content = segmentContent(await tabContent(ctx, id, tabId), segmentId);
    return {
      document_id: id,
      end_index: segmentEnd(content),
      tab_id: tabId ?? null,
      segment_id: segmentId ?? null,
      paragraph_ranges: paragraphs(content).map((p) => ({ start_index: p.startIndex ?? 0, end_index: p.endIndex ?? 0 })),
      display_url: docUrl(id),
    };
  },
};

// ─── Markdown updates ───────────────────────────────────────────────────────

const updateDocumentMarkdown: GoogleTool = {
  name: 'update_document_markdown',
  title: 'Replace document with Markdown',
  description:
    'Replace the whole body of a Google Doc (or of one tab) with Markdown, rendered as native Docs formatting like create_document_markdown. ' +
    'The document id, headers, footers and other tabs stay.',
  inputSchema: schema(
    { id: s('Document id or Docs URL.'), markdown: s('Markdown that replaces the entire body.'), tab_id: s('Tab to replace; the first tab when omitted.') },
    ['id', 'markdown'],
  ),
  annotations: DESTRUCTIVE,
  async run(args, ctx) {
    const id = docIdArg(args, 'id', 'document_id', 'documentId');
    const markdown = markdownArg(args, ['markdown', 'markdown_text', 'content', 'text']);
    const written = await writeMarkdown(ctx, id, markdown, { tabId: optStr(args, 'tab_id', 'tabId') }, { mode: 'replace' }, imageAssets(args));
    return {
      documentId: id,
      replies: written.replies,
      write_control: written.writeControl,
      document_url: docUrl(id),
      display_url: docUrl(id),
      ...(written.warnings.length ? { warnings: written.warnings } : {}),
    };
  },
};

const updateDocumentSectionMarkdown: GoogleTool = {
  name: 'update_document_section_markdown',
  title: 'Insert Markdown into document',
  description:
    'Insert Markdown at start_index, replace start_index..end_index with it, or append it when start_index is omitted. ' +
    'Inserted inside a paragraph, the paragraph is split so the Markdown starts on its own line. Use indexes from get_document_end_index.',
  inputSchema: schema(
    {
      document_id: s('Document id or Docs URL. `id` is an alias.'),
      markdown_text: s('Markdown to insert. Aliases: markdown, content, text, body.'),
      start_index: i('Index to insert at (1 is the start). Omit to append.'),
      end_index: i('End of the range to replace (exclusive). Needs start_index; must not include the last newline of the body.'),
      tab_id: s('Tab to write; the first tab when omitted.'),
    },
    ['document_id', 'markdown_text'],
  ),
  annotations: WRITE,
  async run(args, ctx) {
    const id = docIdArg(args);
    const markdown = markdownArg(args, ['markdown_text', 'markdown', 'content', 'text', 'body', 'markdownText', 'markdown_content']);
    if (!markdown.trim()) throw new ToolInputError('markdown_text is required');
    const start = optInt(args, 'start_index');
    const end = optInt(args, 'end_index');
    if (start !== undefined && end !== undefined && end < start) throw new ToolInputError('end_index must be at least start_index');
    const placement: Placement = start === undefined ? { mode: 'append' } : { mode: 'at', start, end };
    const written = await writeMarkdown(ctx, id, markdown, { tabId: optStr(args, 'tab_id', 'tabId') }, placement, imageAssets(args));
    const message = [...written.notes, ...written.warnings].join(' ');
    return { documentId: id, replies: written.replies, writeControl: written.writeControl, display_url: docUrl(id), ...(message ? { composio_execution_message: message } : {}) };
  },
};

// ─── Text and structure edits ───────────────────────────────────────────────

const insertTextAction: GoogleTool = {
  name: 'insert_text_action',
  title: 'Insert text',
  description: 'Insert plain text at an index inside an existing paragraph, or append it with append_to_end (the default when no index is given).',
  inputSchema: schema(
    {
      document_id: s('Document id or Docs URL.'),
      text_to_insert: s('Text to insert. `text` is an alias.'),
      insertion_index: i('Index to insert at (1 is the start). `index` is an alias.'),
      append_to_end: b('Append to the end of the body or segment; insertion_index is ignored.'),
      segment_id: s('Header, footer or footnote id; the body when omitted.'),
      tab_id: s('Tab id; the first tab when omitted.'),
    },
    ['document_id', 'text_to_insert'],
  ),
  annotations: WRITE,
  async run(args, ctx) {
    const id = docIdArg(args);
    const text = typeof args.text_to_insert === 'string' ? args.text_to_insert : typeof args.text === 'string' ? args.text : '';
    if (!text) throw new ToolInputError('text_to_insert is required');
    const target: DocsTarget = { segmentId: optStr(args, 'segment_id', 'segmentId'), tabId: optStr(args, 'tab_id', 'tabId') };
    const index = num(args.insertion_index) ?? num(args.index);
    let requests: Json[];
    if (optBool(args, 'append_to_end', false) || index === undefined) {
      const seg = { ...(target.segmentId ? { segmentId: target.segmentId } : {}), ...(target.tabId ? { tabId: target.tabId } : {}) };
      requests = [{ insertText: { text, endOfSegmentLocation: seg } }];
    } else {
      requests = textInserts(text, index, target);
    }
    return snakeOut(id, await batchUpdate(ctx, id, requests));
  },
};

const replaceAllText: GoogleTool = {
  name: 'replace_all_text',
  title: 'Replace text',
  description: 'Replace every match of find_text with replace_text, in all tabs or in tab_ids. Case-insensitive by default; search_by_regex uses RE2 syntax.',
  inputSchema: schema(
    {
      document_id: s('Document id or Docs URL.'),
      find_text: s('Text (or regular expression) to find. Not empty.'),
      replace_text: s('Replacement text; empty deletes the matches.'),
      match_case: b('Case-sensitive matching.', { default: false }),
      search_by_regex: b('find_text is a regular expression.', { default: false }),
      tab_ids: strs('Only these tabs; every tab when omitted.'),
    },
    ['document_id', 'find_text', 'replace_text'],
  ),
  annotations: WRITE,
  async run(args, ctx) {
    const id = docIdArg(args);
    const find = typeof args.find_text === 'string' ? args.find_text : '';
    if (!find) throw new ToolInputError('find_text is required and cannot be empty');
    const tabIds = strList(args, 'tab_ids');
    const result = await batchUpdate(ctx, id, [
      {
        replaceAllText: {
          containsText: { text: find, matchCase: optBool(args, 'match_case', false), ...(optBool(args, 'search_by_regex', false) ? { searchByRegex: true } : {}) },
          replaceText: typeof args.replace_text === 'string' ? args.replace_text : '',
          ...(tabIds.length ? { tabsCriteria: { tabIds } } : {}),
        },
      },
    ]);
    return { ...snakeOut(id, result), document_url: docUrl(id) };
  },
};

const STYLE_KEYS: Record<string, string> = {
  updateTextStyle: 'textStyle',
  updateParagraphStyle: 'paragraphStyle',
  updateTableCellStyle: 'tableCellStyle',
  updateDocumentStyle: 'documentStyle',
  updateSectionStyle: 'sectionStyle',
  updateTableRowStyle: 'tableRowStyle',
  updateTableColumnProperties: 'tableColumnProperties',
  updateDocumentTabProperties: 'tabProperties',
};

/** Composio's corrections: append an insertText without a location, fill a missing `fields`, drop empty text-style ranges. */
function normalizeRequests(value: unknown, key: string): { requests: Json[]; notes: string[] } {
  if (!Array.isArray(value) || !value.length) throw new ToolInputError(`${key} must be a non-empty list of Docs requests`);
  const notes = new Set<string>();
  const requests: Json[] = [];
  value.forEach((item, index) => {
    const request = obj(item);
    const entries = request ? Object.entries(request) : [];
    if (entries.length !== 1 || !obj(entries[0]![1])) throw new ToolInputError(`${key}[${index}] must be an object with exactly one request type, such as {"insertText": {...}}`);
    const [type, raw] = entries[0] as [string, Json];
    const body = { ...raw };
    if (type === 'insertText' && !body.location && !body.endOfSegmentLocation) {
      body.endOfSegmentLocation = {};
      notes.add('insertText without a location appends to the end of the body.');
    }
    const range = obj(body.range);
    if (type === 'updateTextStyle' && range && (num(range.startIndex) ?? 0) >= (num(range.endIndex) ?? 0)) {
      notes.add('updateTextStyle requests with an empty range were dropped.');
      return;
    }
    const styleKey = STYLE_KEYS[type];
    const style = styleKey ? obj(body[styleKey]) : undefined;
    if (styleKey && !body.fields && style) {
      body.fields = Object.keys(style).filter((k) => k !== 'tabId').join(',') || '*';
      notes.add(`fields was filled from the keys of ${styleKey}.`);
    }
    requests.push({ [type]: body });
  });
  return { requests, notes: [...notes] };
}

const updateExistingDocument: GoogleTool = {
  name: 'update_existing_document',
  title: 'Edit document',
  description:
    'Apply Docs API batchUpdate requests in order: insertText, deleteContentRange, updateTextStyle, updateParagraphStyle, createParagraphBullets, insertTable, ' +
    'replaceAllText, … Each item has exactly one request type. Edits shift later indexes: work from the highest index down. ' +
    'Reference: https://developers.google.com/docs/api/reference/rest/v1/documents/batchUpdate',
  inputSchema: schema(
    { document_id: s('Document id or Docs URL.'), edit_docs: arr({ type: 'object', additionalProperties: true }, 'Docs API requests, such as {"insertText": {"location": {"index": 1}, "text": "Hi"}}.') },
    ['document_id', 'edit_docs'],
  ),
  annotations: WRITE,
  async run(args, ctx) {
    const id = docIdArg(args);
    const { requests, notes } = normalizeRequests(args.edit_docs ?? args.requests, 'edit_docs');
    const result = await batchUpdate(ctx, id, requests);
    return { ...camelOut(id, result), ...(notes.length ? { composio_execution_message: notes.join(' ') } : {}) };
  },
};

const updateDocumentBatch: GoogleTool = {
  name: 'update_document_batch',
  title: 'Edit document (batch)',
  description: 'Apply Docs API batchUpdate requests, with optional write_control. Deprecated: same as update_existing_document.',
  inputSchema: schema(
    {
      document_id: s('Document id or Docs URL.'),
      requests: arr({ type: 'object', additionalProperties: true }, 'Docs API requests, one request type each.'),
      write_control: anyObj('{requiredRevisionId} or {targetRevisionId}.'),
    },
    ['document_id', 'requests'],
  ),
  annotations: WRITE,
  async run(args, ctx) {
    const id = docIdArg(args);
    const { requests, notes } = normalizeRequests(args.requests ?? args.edit_docs, 'requests');
    const result = await batchUpdate(ctx, id, requests, optObj(args, 'write_control'));
    return {
      documentId: id,
      replies: result.replies,
      writeControl: result.writeControl,
      document_url: docUrl(id),
      ...(notes.length ? { composio_execution_message: notes.join(' ') } : {}),
    };
  },
};

const RANGE_DOC = '{startIndex, endIndex, segmentId?, tabId?}';

function rangeArg(args: Json, tabKey?: string): Json {
  const range = reqObj(args, 'range');
  const start = num(range.startIndex ?? range.start_index);
  const end = num(range.endIndex ?? range.end_index);
  if (start === undefined || end === undefined || end <= start) throw new ToolInputError('range needs startIndex < endIndex');
  const segmentId = range.segmentId ?? range.segment_id;
  const tabId = range.tabId ?? range.tab_id ?? (tabKey ? optStr(args, tabKey) : undefined);
  return { startIndex: start, endIndex: end, ...(segmentId ? { segmentId } : {}), ...(tabId ? { tabId } : {}) };
}

const deleteContentRange = batchTool({
  name: 'delete_content_range',
  title: 'Delete content',
  description: 'Delete the content between two indexes. A segment\'s last newline cannot be deleted: end before it.',
  props: { document_id: s('Document id or Docs URL.'), range: anyObj(`${RANGE_DOC}, end exclusive.`) },
  required: ['document_id', 'range'],
  annotations: DESTRUCTIVE,
  requests: (args) => [{ deleteContentRange: { range: rangeArg(args) } }],
  output: (id, r) => ({ documentId: id, replies: r.replies, writeControl: r.writeControl, displayUrl: docUrl(id) }),
});

const createParagraphBullets = batchTool({
  name: 'create_paragraph_bullets',
  title: 'Add bullets',
  description: 'Turn the paragraphs in a range into a bulleted, numbered or checkbox list. Leading tabs set the nesting level and are removed.',
  props: {
    document_id: s('Document id or Docs URL.'),
    createParagraphBullets: anyObj(`{range: ${RANGE_DOC}, bulletPreset}, such as bulletPreset BULLET_DISC_CIRCLE_SQUARE, NUMBERED_DECIMAL_ALPHA_ROMAN or BULLET_CHECKBOX.`),
    tabId: s('Tab of the range; the first tab when omitted.'),
  },
  required: ['document_id', 'createParagraphBullets'],
  requests(args) {
    const body = reqObj(args, 'createParagraphBullets', 'create_paragraph_bullets');
    const range = { ...reqObj(body, 'range') };
    const tabId = optStr(args, 'tabId', 'tab_id');
    if (tabId) range.tabId = tabId;
    return [{ createParagraphBullets: { ...body, range, bulletPreset: body.bulletPreset ?? 'BULLET_DISC_CIRCLE_SQUARE' } }];
  },
});

const deleteParagraphBullets = batchTool({
  name: 'delete_paragraph_bullets',
  title: 'Remove bullets',
  description: 'Remove bullets from the paragraphs in a range. Their indent stays.',
  props: { document_id: s('Document id or Docs URL.'), range: anyObj(RANGE_DOC), tab_id: s('Tab of the range; the first tab when omitted.') },
  required: ['document_id', 'range'],
  requests: (args) => [{ deleteParagraphBullets: { range: rangeArg(args, 'tab_id') } }],
});

const insertPageBreak = batchTool({
  name: 'insert_page_break',
  title: 'Insert page break',
  description: 'Insert a page break at an index ({location: {index}}) or at the end of the body ({endOfSegmentLocation: {}}).',
  props: { documentId: s('Document id or Docs URL.'), insertPageBreak: anyObj('{location: {index, tabId?}} or {endOfSegmentLocation: {tabId?}}.') },
  required: ['documentId', 'insertPageBreak'],
  requests(args) {
    const body = optObj(args, 'insertPageBreak') ?? optObj(args, 'insert_page_break') ?? {};
    return [{ insertPageBreak: body.location || body.endOfSegmentLocation ? body : { endOfSegmentLocation: {} } }];
  },
});

function tableLocation(args: Json): Json {
  const index = num(args.index);
  const segmentId = optStr(args, 'segmentId', 'segment_id');
  const tabId = optStr(args, 'tabId', 'tab_id');
  const seg = { ...(segmentId ? { segmentId } : {}), ...(tabId ? { tabId } : {}) };
  return index !== undefined && !optBool(args, 'insertAtEndOfSegment', false) ? { location: { index, ...seg } } : { endOfSegmentLocation: seg };
}

function tableSize(args: Json, max?: number): { rows: number; columns: number } {
  const rows = reqInt(args, 'rows');
  const columns = reqInt(args, 'columns');
  if (rows < 1 || columns < 1 || (max && (rows > max || columns > max))) throw new ToolInputError(`rows and columns must be between 1 and ${max ?? 'the Docs limit'}`);
  return { rows, columns };
}

const TABLE_PROPS = {
  documentId: s('Document id or Docs URL.'),
  rows: i('Number of rows.'),
  columns: i('Number of columns.'),
  index: i('Index to insert at, inside a paragraph and below the end index. Omit to append.'),
  insertAtEndOfSegment: b('Append to the end of the body (or segmentId).'),
  segmentId: s('Header, footer or footnote id; the body when omitted.'),
  tabId: s('Tab id; the first tab when omitted.'),
};

const insertTableAction = batchTool({
  name: 'insert_table_action',
  title: 'Insert table',
  description: 'Insert an empty table at an index or at the end of the body. Docs puts a newline before the table, so it starts at index + 1.',
  props: TABLE_PROPS,
  required: ['documentId', 'rows', 'columns'],
  requests: (args) => [{ insertTable: { ...tableSize(args), ...tableLocation(args) } }],
  output: (id, r) => ({ documentId: id, replies: r.replies, writeControl: r.writeControl, displayUrl: docUrl(id) }),
});

const createAndPopulateTable: GoogleTool = {
  name: 'create_and_populate_table',
  title: 'Insert table with content',
  description: 'Insert a table (up to 20 × 20) and fill its cells from cellData, a list of rows of cell text. Appends to the body when index is omitted.',
  inputSchema: schema({ ...TABLE_PROPS, cellData: arr({ type: 'array', items: { type: 'string' } }, 'Rows of cell text; must be rows × columns. Empty strings leave a cell empty.') }, [
    'documentId',
    'rows',
    'columns',
    'cellData',
  ]),
  annotations: WRITE,
  async run(args, ctx) {
    const id = docIdArg(args, 'documentId', 'document_id', 'id');
    const { rows, columns } = tableSize(args, MAX_TABLE_SIZE);
    const data = Array.isArray(args.cellData) ? args.cellData : Array.isArray(args.cell_data) ? args.cell_data : null;
    if (!data || data.length !== rows || data.some((row) => !Array.isArray(row) || row.length !== columns)) {
      throw new ToolInputError(`cellData must be ${rows} rows of ${columns} cells`);
    }
    const location = tableLocation(args);
    const created = await batchUpdate(ctx, id, [{ insertTable: { rows, columns, ...location } }]);
    const tabId = optStr(args, 'tabId', 'tab_id');
    const segmentId = optStr(args, 'segmentId', 'segment_id');
    const content = segmentContent(await tabContent(ctx, id, tabId), segmentId);
    const tables = content.filter((e) => e.table);
    const at = (location.location as Json | undefined)?.index as number | undefined;
    const table = at === undefined ? tables[tables.length - 1] : (tables.find((t) => t.startIndex === at + 1) ?? tables.find((t) => (t.startIndex ?? 0) > at));
    const tableStart = table?.startIndex;
    if (tableStart === undefined) throw new Error('Google Docs inserted the table, but Kortix could not find it to fill the cells');
    const fills: Json[] = [];
    // Last cell first: filling it leaves the earlier cells' indexes unchanged.
    for (let r = rows - 1; r >= 0; r--) {
      for (let c = columns - 1; c >= 0; c--) {
        const text = String((data[r] as unknown[])[c] ?? '');
        if (!text) continue;
        const { start } = tableCellIndex(content, tableStart, r, c);
        fills.push({ insertText: { text, location: { index: start, ...(segmentId ? { segmentId } : {}), ...(tabId ? { tabId } : {}) } } });
      }
    }
    const filled = await batchUpdate(ctx, id, fills);
    return {
      documentId: id,
      replies: [...created.replies, ...filled.replies],
      writeControl: filled.writeControl ?? created.writeControl,
      displayUrl: docUrl(id),
      tableStartIndex: tableStart,
      cellsPopulated: fills.length,
    };
  },
};

const TABLE_CELL_LOCATION_DOC = '{tableStartLocation: {index, tabId?, segmentId?}, rowIndex, columnIndex}';

function tableRequests(args: Json, type: 'insertTableRow' | 'insertTableColumn' | 'deleteTableRow' | 'deleteTableColumn', defaults: Json = {}): Json[] {
  const list = args.requests;
  if (!Array.isArray(list) || !list.length) throw new ToolInputError(`requests must be a non-empty list of {"${type}": {...}}`);
  return list.map((item, index) => {
    const body = obj(obj(item)?.[type]) ?? (obj(item)?.tableCellLocation ? obj(item) : undefined);
    if (!body?.tableCellLocation) throw new ToolInputError(`requests[${index}] must be {"${type}": {"tableCellLocation": ${TABLE_CELL_LOCATION_DOC}}}`);
    return { [type]: { ...defaults, ...body } };
  });
}

const insertTableRow = batchTool({
  name: 'insert_table_row',
  title: 'Insert table row',
  description: 'Insert a row above or below a reference cell (insertBelow defaults to true). Several requests run in order.',
  props: { document_id: s('Document id or Docs URL.'), requests: arr({ type: 'object', additionalProperties: true }, `[{insertTableRow: {tableCellLocation: ${TABLE_CELL_LOCATION_DOC}, insertBelow}}].`) },
  required: ['document_id', 'requests'],
  requests: (args) => tableRequests(args, 'insertTableRow', { insertBelow: true }),
});

const insertTableColumn = batchTool({
  name: 'insert_table_column',
  title: 'Insert table column',
  description: 'Insert a column left or right of a reference cell (insertRight defaults to false). Several requests run in order.',
  props: { document_id: s('Document id or Docs URL.'), requests: arr({ type: 'object', additionalProperties: true }, `[{insertTableColumn: {tableCellLocation: ${TABLE_CELL_LOCATION_DOC}, insertRight}}].`) },
  required: ['document_id', 'requests'],
  requests: (args) => tableRequests(args, 'insertTableColumn', { insertRight: false }),
});

const deleteTableColumn = batchTool({
  name: 'delete_table_column',
  title: 'Delete table column',
  description: 'Delete the column of a reference cell. Several requests run in order.',
  props: { document_id: s('Document id or Docs URL.'), requests: arr({ type: 'object', additionalProperties: true }, `[{deleteTableColumn: {tableCellLocation: ${TABLE_CELL_LOCATION_DOC}}}].`) },
  required: ['document_id', 'requests'],
  annotations: DESTRUCTIVE,
  requests: (args) => tableRequests(args, 'deleteTableColumn'),
});

const deleteTableRow = batchTool({
  name: 'delete_table_row',
  title: 'Delete table row',
  description: 'Delete the row of a reference cell.',
  props: { documentId: s('Document id or Docs URL.'), tableCellLocation: anyObj(TABLE_CELL_LOCATION_DOC) },
  required: ['documentId', 'tableCellLocation'],
  annotations: DESTRUCTIVE,
  requests: (args) => [{ deleteTableRow: { tableCellLocation: reqObj(args, 'tableCellLocation', 'table_cell_location') } }],
});

const unmergeTableCells = batchTool({
  name: 'unmerge_table_cells',
  title: 'Unmerge table cells',
  description: 'Split merged cells in a table range back into single cells.',
  props: { documentId: s('Document id or Docs URL.'), tableRange: anyObj(`{tableCellLocation: ${TABLE_CELL_LOCATION_DOC}, rowSpan, columnSpan}.`) },
  required: ['documentId', 'tableRange'],
  requests: (args) => [{ unmergeTableCells: { tableRange: reqObj(args, 'tableRange', 'table_range') } }],
});

const updateTableRowStyle = batchTool({
  name: 'update_table_row_style',
  title: 'Style table rows',
  description: 'Set the minimum height or overflow behavior of table rows.',
  props: {
    documentId: s('Document id or Docs URL.'),
    updateTableRowStyle: anyObj('{tableStartLocation: {index}, rowIndices?, tableRowStyle: {minRowHeight: {magnitude, unit: "PT"}, preventOverflow}, fields}.'),
  },
  required: ['documentId', 'updateTableRowStyle'],
  requests(args) {
    const body = { ...reqObj(args, 'updateTableRowStyle', 'update_table_row_style') };
    const style = obj(body.tableRowStyle);
    if (!body.fields && style) body.fields = Object.keys(style).join(',');
    return [{ updateTableRowStyle: body }];
  },
});

const insertTextInTableCell: GoogleTool = {
  name: 'insert_text_in_table_cell',
  title: 'Insert text in table cell',
  description: 'Insert text at the start of one table cell, found by the table\'s start index and zero-based row and column.',
  inputSchema: schema(
    {
      document_id: s('Document id or Docs URL.'),
      text: s('Text to insert.'),
      table_start_index: i('startIndex of the table, from get_document_by_id.'),
      row_index: i('Zero-based row.'),
      column_index: i('Zero-based column.'),
      tabId: s('Tab id; the first tab when omitted.'),
    },
    ['document_id', 'text', 'table_start_index', 'row_index', 'column_index'],
  ),
  annotations: WRITE,
  async run(args, ctx) {
    const id = docIdArg(args);
    const text = reqStr(args, 'text');
    const tabId = optStr(args, 'tabId', 'tab_id');
    const content = (await tabContent(ctx, id, tabId)).body?.content ?? [];
    const { start } = tableCellIndex(content, reqInt(args, 'table_start_index'), reqInt(args, 'row_index'), reqInt(args, 'column_index'));
    const result = await batchUpdate(ctx, id, [{ insertText: { text, location: withTab(tabId, { index: start }) } }]);
    return { documentId: id, replies: result.replies, writeControl: result.writeControl, display_url: docUrl(id), cell_index: start };
  },
};

// ─── Images ─────────────────────────────────────────────────────────────────

const IMAGE_URI = s('Public, direct image URL (PNG, JPEG or GIF, under 50 MB, at most 2 kB long). Docs fetches it once.');
const SIZE_DOC = '{width: {magnitude, unit: "PT"}, height: {magnitude, unit: "PT"}}; the image\'s own size when omitted.';

const insertInlineImage: GoogleTool = {
  name: 'insert_inline_image',
  title: 'Insert image',
  description: 'Insert an image from a public URL at an index, as an inline image.',
  inputSchema: schema({ documentId: s('Document id or Docs URL.'), uri: IMAGE_URI, location: anyObj('{index, segmentId?, tabId?}.'), objectSize: anyObj(SIZE_DOC) }, [
    'documentId',
    'uri',
    'location',
  ]),
  annotations: WRITE,
  async run(args, ctx) {
    const id = docIdArg(args, 'documentId', 'document_id', 'id');
    const size = optObj(args, 'objectSize') ?? optObj(args, 'object_size');
    const result = await batchUpdate(ctx, id, [{ insertInlineImage: { uri: reqStr(args, 'uri'), location: reqObj(args, 'location'), ...(size ? { objectSize: size } : {}) } }]);
    const reply = obj(obj(result.replies[0])?.insertInlineImage);
    return { objectId: reply?.objectId ?? null, display_url: docUrl(id) };
  },
};

const insertImageInTableCell: GoogleTool = {
  name: 'insert_image_in_table_cell',
  title: 'Insert image in table cell',
  description: 'Insert an image from a public URL into one table cell, found by the table\'s start index and zero-based row and column.',
  inputSchema: schema(
    {
      document_id: s('Document id or Docs URL.'),
      uri: IMAGE_URI,
      table_cell_location: anyObj('{table_start_index, row_index, column_index, tab_id?, segment_id?}.'),
      cell_content_index: i('Offset inside the cell\'s text; 0 is the start.', { default: 0 }),
      object_size: anyObj(SIZE_DOC),
    },
    ['document_id', 'uri', 'table_cell_location'],
  ),
  annotations: WRITE,
  async run(args, ctx) {
    const id = docIdArg(args);
    const where = reqObj(args, 'table_cell_location', 'tableCellLocation');
    const tableStart = num(where.table_start_index ?? where.tableStartIndex);
    const row = num(where.row_index ?? where.rowIndex);
    const column = num(where.column_index ?? where.columnIndex);
    if (tableStart === undefined || row === undefined || column === undefined) throw new ToolInputError('table_cell_location needs table_start_index, row_index and column_index');
    const tabId = typeof where.tab_id === 'string' ? where.tab_id : typeof where.tabId === 'string' ? where.tabId : undefined;
    const segmentId = typeof where.segment_id === 'string' ? where.segment_id : undefined;
    const content = segmentContent(await tabContent(ctx, id, tabId), segmentId);
    const cell = tableCellIndex(content, tableStart, row, column);
    const index = Math.min(cell.start + Math.max(0, optInt(args, 'cell_content_index', 0) ?? 0), cell.end - 1);
    const size = optObj(args, 'object_size') ?? optObj(args, 'objectSize');
    const location = { index, ...(segmentId ? { segmentId } : {}), ...(tabId ? { tabId } : {}) };
    const result = await batchUpdate(ctx, id, [{ insertInlineImage: { uri: reqStr(args, 'uri'), location, ...(size ? { objectSize: size } : {}) } }]);
    return { document_id: id, object_id: obj(obj(result.replies[0])?.insertInlineImage)?.objectId ?? null, display_url: docUrl(id) };
  },
};

const replaceImage = batchTool({
  name: 'replace_image',
  title: 'Replace image',
  description: 'Replace an image in the document with an image from a public URL. The image id is an inlineObjects key of get_document_by_id.',
  props: {
    document_id: s('Document id or Docs URL.'),
    replace_image: anyObj('{image_object_id, uri, image_replace_method: CENTER_CROP (default), tab_id?}.'),
  },
  required: ['document_id', 'replace_image'],
  requests(args) {
    const body = reqObj(args, 'replace_image', 'replaceImage');
    const imageObjectId = body.image_object_id ?? body.imageObjectId;
    const uri = body.uri;
    if (typeof imageObjectId !== 'string' || typeof uri !== 'string') throw new ToolInputError('replace_image needs image_object_id and uri');
    const tabId = body.tab_id ?? body.tabId;
    return [{ replaceImage: { imageObjectId, uri, imageReplaceMethod: body.image_replace_method ?? body.imageReplaceMethod ?? 'CENTER_CROP', ...(tabId ? { tabId } : {}) } }];
  },
  output: snakeOut,
});

// ─── Headers, footers, footnotes, named ranges ──────────────────────────────

const alreadyExists = (error: unknown) => error instanceof GoogleApiError && /already exists/i.test(error.message);

const createHeader: GoogleTool = {
  name: 'create_header',
  title: 'Create header',
  description: 'Create the default header (or a section\'s header) and optionally write text in it. When the default header exists, its id is returned.',
  inputSchema: schema(
    {
      documentId: s('Document id or Docs URL.'),
      type: s('Header type.', { enum: ['HEADER_FOOTER_TYPE_UNSPECIFIED', 'DEFAULT'], default: 'DEFAULT' }),
      sectionBreakLocation: anyObj('{index, tabId?} of the section break that starts the section; the document\'s header when omitted.'),
      text: s('Text to write in the header.'),
    },
    ['documentId'],
  ),
  annotations: WRITE,
  async run(args, ctx) {
    const id = docIdArg(args, 'documentId', 'document_id', 'id');
    const section = optObj(args, 'sectionBreakLocation') ?? optObj(args, 'section_break_location');
    let headerId: string | undefined;
    let replies: unknown[] = [];
    let writeControl: Json | undefined;
    const messages: string[] = [];
    try {
      const result = await batchUpdate(ctx, id, [{ createHeader: { type: 'DEFAULT', ...(section ? { sectionBreakLocation: section } : {}) } }]);
      ({ replies, writeControl } = result);
      headerId = obj(obj(replies[0])?.createHeader)?.headerId as string | undefined;
    } catch (error) {
      if (!alreadyExists(error)) throw error;
      headerId = (await getDoc(ctx, id, false)).documentStyle?.defaultHeaderId;
      if (!headerId) throw error;
      messages.push('The document already has a default header; its id is returned.');
    }
    const text = optStr(args, 'text');
    let inserted: boolean | null = null;
    if (text && headerId) {
      try {
        const result = await batchUpdate(ctx, id, [{ insertText: { text, location: { segmentId: headerId, index: 0 } } }]);
        replies = [...replies, ...result.replies];
        writeControl = result.writeControl ?? writeControl;
        inserted = true;
        messages.push('The text was written in the header.');
      } catch (error) {
        inserted = false;
        messages.push(`The header exists, but writing its text failed: ${(error as Error).message}`);
      }
    }
    return { documentId: id, header_id: headerId, replies, writeControl, display_url: docUrl(id), header_text_inserted: inserted, composio_execution_message: messages.join(' ') || undefined };
  },
};

const createFooter: GoogleTool = {
  name: 'create_footer',
  title: 'Create footer',
  description: 'Create the default footer (or a section\'s footer). When the default footer exists, its id is returned.',
  inputSchema: schema(
    { document_id: s('Document id or Docs URL.'), type: s('Footer type.', { enum: ['DEFAULT'] }), section_break_location: anyObj('{index, tabId?} of the section break that starts the section.') },
    ['document_id', 'type'],
  ),
  annotations: WRITE,
  async run(args, ctx) {
    const id = docIdArg(args);
    const section = optObj(args, 'section_break_location') ?? optObj(args, 'sectionBreakLocation');
    try {
      const result = await batchUpdate(ctx, id, [{ createFooter: { type: 'DEFAULT', ...(section ? { sectionBreakLocation: section } : {}) } }]);
      return { footer_id: obj(obj(result.replies[0])?.createFooter)?.footerId, display_url: docUrl(id) };
    } catch (error) {
      if (!alreadyExists(error)) throw error;
      const footerId = (await getDoc(ctx, id, false)).documentStyle?.defaultFooterId;
      if (!footerId) throw error;
      return { footer_id: footerId, display_url: docUrl(id), composio_execution_message: 'The document already has a default footer; its id is returned.' };
    }
  },
};

function deleteHeaderFooter(kind: 'header' | 'footer'): GoogleTool {
  const key = `${kind}_id`;
  return batchTool({
    name: `delete_${kind}`,
    title: `Delete ${kind}`,
    description: `Delete a ${kind} by id (from create_${kind} or the ${kind}s of get_document_by_id).`,
    props: { document_id: s('Document id or Docs URL.'), [key]: s(`The ${kind} id.`), tab_id: s(`Tab of the ${kind}; the first tab when omitted.`) },
    required: ['document_id', key],
    annotations: DESTRUCTIVE,
    requests(args) {
      const field = kind === 'header' ? 'headerId' : 'footerId';
      const request = kind === 'header' ? 'deleteHeader' : 'deleteFooter';
      return [{ [request]: withTab(optStr(args, 'tab_id', 'tabId'), { [field]: reqStr(args, key, field) }) }];
    },
    output: snakeOut,
  });
}

const createFootnote = batchTool({
  name: 'create_footnote',
  title: 'Create footnote',
  description: 'Insert a footnote reference at an index, or at the end of the body when no location is given. Write the footnote text with insert_text_action and its segment id.',
  props: {
    documentId: s('Document id or Docs URL.'),
    location: anyObj('{index, tabId?} in the body.'),
    endOfSegmentLocation: anyObj('{tabId?}: the end of the body.'),
  },
  required: ['documentId'],
  requests(args) {
    const location = optObj(args, 'location');
    return [{ createFootnote: location ? { location } : { endOfSegmentLocation: optObj(args, 'endOfSegmentLocation') ?? {} } }];
  },
});

const createNamedRange: GoogleTool = {
  name: 'create_named_range',
  title: 'Create named range',
  description: 'Name a range of the document so later edits can find it.',
  inputSchema: schema(
    {
      documentId: s('Document id or Docs URL.'),
      name: s('Range name, 1–256 characters.'),
      rangeStartIndex: i('Start index.'),
      rangeEndIndex: i('End index (exclusive).'),
      rangeSegmentId: s('Header, footer or footnote id; the body when omitted.'),
      tabId: s('Tab id; the first tab when omitted.'),
    },
    ['documentId', 'name', 'rangeStartIndex', 'rangeEndIndex'],
  ),
  annotations: WRITE,
  async run(args, ctx) {
    const id = docIdArg(args, 'documentId', 'document_id', 'id');
    const segmentId = optStr(args, 'rangeSegmentId');
    const range = withTab(optStr(args, 'tabId', 'tab_id'), { startIndex: reqInt(args, 'rangeStartIndex'), endIndex: reqInt(args, 'rangeEndIndex'), ...(segmentId ? { segmentId } : {}) });
    const result = await batchUpdate(ctx, id, [{ createNamedRange: { name: reqStr(args, 'name'), range } }]);
    return { namedRangeId: obj(obj(result.replies[0])?.createNamedRange)?.namedRangeId ?? null, display_url: docUrl(id) };
  },
};

const deleteNamedRange = batchTool({
  name: 'delete_named_range',
  title: 'Delete named range',
  description: 'Delete a named range by id or by name. The text stays.',
  props: { document_id: s('Document id or Docs URL.'), deleteNamedRange: anyObj('{namedRangeId} or {name}, with optional tabsCriteria {tabIds}.') },
  required: ['document_id', 'deleteNamedRange'],
  annotations: DESTRUCTIVE,
  requests(args) {
    const body = reqObj(args, 'deleteNamedRange', 'delete_named_range');
    if (!body.name && !body.namedRangeId) throw new ToolInputError('deleteNamedRange needs namedRangeId or name');
    return [{ deleteNamedRange: body }];
  },
});

// ─── Tabs and document style ────────────────────────────────────────────────

/** `fields: "*"` means the keys that are set, as Composio did. */
const fieldsFor = (fields: string | undefined, value: Json) => (!fields || fields === '*' ? Object.keys(value).filter((k) => k !== 'tabId').join(',') : fields);

const createTab = batchTool({
  name: 'create_tab',
  title: 'Create tab',
  description: 'Add a tab to a document. Later tabs move down one index.',
  props: { document_id: s('Document id or Docs URL.'), tab_properties: anyObj('{title?, index?, parentTabId?}.') },
  required: ['document_id'],
  requests: (args) => [{ addDocumentTab: { tabProperties: optObj(args, 'tab_properties') ?? optObj(args, 'tabProperties') ?? {} } }],
  output: (id, r) => ({ documentId: id, replies: r.replies, display_url: docUrl(id) }),
});

const deleteTab = batchTool({
  name: 'delete_tab',
  title: 'Delete tab',
  description: 'Delete a tab and its child tabs, with their content. This cannot be undone.',
  props: { document_id: s('Document id or Docs URL.'), tab_id: s('Tab id.') },
  required: ['document_id', 'tab_id'],
  annotations: DESTRUCTIVE,
  requests: (args) => [{ deleteTab: { tabId: reqStr(args, 'tab_id', 'tabId') } }],
});

const updateTabProperties = batchTool({
  name: 'update_tab_properties',
  title: 'Update tab',
  description: 'Rename a tab, change its icon emoji, or move it (index, parentTabId).',
  props: {
    document_id: s('Document id or Docs URL.'),
    tab_id: s('Tab id.'),
    tab_properties: anyObj('{title?, iconEmoji?, index?, parentTabId?}.'),
    fields: s('Fields to update; * updates the ones set in tab_properties.', { default: '*' }),
  },
  required: ['document_id', 'tab_id', 'tab_properties'],
  requests(args) {
    const props = reqObj(args, 'tab_properties', 'tabProperties');
    return [{ updateDocumentTabProperties: { tabProperties: { ...props, tabId: reqStr(args, 'tab_id', 'tabId') }, fields: fieldsFor(optStr(args, 'fields'), props) } }];
  },
});

const updateDocumentStyle = batchTool({
  name: 'update_document_style',
  title: 'Update document style',
  description: 'Change page size, margins, background or page numbering of the document (or a tab).',
  props: {
    document_id: s('Document id or Docs URL.'),
    document_style: anyObj('DocumentStyle fields, such as {marginTop: {magnitude: 36, unit: "PT"}, pageSize: {...}}.'),
    fields: s('Fields to update; * updates the ones set in document_style.', { default: '*' }),
    tab_id: s('Tab id; the first tab when omitted.'),
  },
  required: ['document_id', 'document_style'],
  requests(args) {
    const style = reqObj(args, 'document_style', 'documentStyle');
    return [{ updateDocumentStyle: withTab(optStr(args, 'tab_id', 'tabId'), { documentStyle: style, fields: fieldsFor(optStr(args, 'fields'), style) }) }];
  },
});

// ─── Drive ──────────────────────────────────────────────────────────────────

/** Drive's camelCase keys as Composio's snake_case; property maps keep their keys. */
function snake(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(snake);
  const record = obj(value);
  if (!record) return value;
  const out: Json = {};
  for (const [key, v] of Object.entries(record)) {
    out[key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)] = ['properties', 'appProperties', 'exportLinks'].includes(key) ? v : snake(v);
  }
  return out;
}

const DRIVE_QUERY = /\b(name|fullText|mimeType|modifiedTime|createdTime|viewedByMeTime|trashed|starred|sharedWithMe|properties|appProperties|visibility)\s*(contains|=|!=|<=?|>=?|has)|'[^']*'\s+in\s+(parents|owners|writers|readers)/i;
const quote = (value: string) => `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

const searchDocuments: GoogleTool = {
  name: 'search_documents',
  title: 'Search documents',
  description:
    'Find Google Docs by text in their content and name, or with a Drive query (`name contains \'plan\' and modifiedTime > \'2026-01-01\'`). ' +
    'Filter by dates, starred and shared-with-me. Page with page_token.',
  inputSchema: schema({
    query: s('Plain text (searches content and name) or a Drive query. Empty lists every document.'),
    max_results: i('Documents per page, 1–100.', { default: 10 }),
    page_token: s('next_page_token of the previous page. `pageToken` is an alias.'),
    order_by: s('Sort order, such as `modifiedTime desc` or `name`. Ignored for text searches, which sort by relevance.', { default: 'modifiedTime desc' }),
    created_after: s('RFC 3339 time, such as 2026-01-01T00:00:00Z.'),
    modified_after: s('RFC 3339 time.'),
    starred_only: b('Only starred documents.', { default: false }),
    shared_with_me: b('Only documents shared with the account.', { default: false }),
    include_trashed: b('Include documents in the trash.', { default: false }),
    include_shared_drives: b('Include shared drives.', { default: true }),
    response_detail: s('minimal: id, name, modifiedTime, webViewLink. full: every Drive field.', { enum: ['minimal', 'full'], default: 'minimal' }),
  }),
  annotations: READ,
  async run(args, ctx) {
    const terms = [`mimeType = '${DOC_MIME}'`];
    const query = optStr(args, 'query', 'q')?.trim();
    if (query) terms.push(DRIVE_QUERY.test(query) ? `(${query})` : `fullText contains ${quote(query)}`);
    if (!optBool(args, 'include_trashed', false)) terms.push('trashed = false');
    if (optBool(args, 'starred_only', false)) terms.push('starred = true');
    if (optBool(args, 'shared_with_me', false)) terms.push('sharedWithMe = true');
    const created = optStr(args, 'created_after');
    const modified = optStr(args, 'modified_after');
    if (created) terms.push(`createdTime > ${quote(created)}`);
    if (modified) terms.push(`modifiedTime > ${quote(modified)}`);
    const q = terms.join(' and ');
    const fullText = /fullText/i.test(q);
    const sharedDrives = optBool(args, 'include_shared_drives', true);
    const full = optStr(args, 'response_detail') === 'full';
    const list = await ctx.google.json<{ kind?: string; files?: unknown[]; nextPageToken?: string; incompleteSearch?: boolean }>({
      url: `${DRIVE}/files`,
      query: {
        q,
        pageSize: Math.max(1, optInt(args, 'max_results', 10, 100) ?? 10),
        pageToken: optStr(args, 'page_token', 'pageToken'),
        orderBy: fullText ? undefined : (optStr(args, 'order_by') ?? 'modifiedTime desc'),
        fields: full ? 'kind,nextPageToken,incompleteSearch,files(*)' : 'kind,nextPageToken,incompleteSearch,files(id,name,mimeType,modifiedTime,webViewLink)',
        ...(sharedDrives ? { corpora: 'allDrives', includeItemsFromAllDrives: true, supportsAllDrives: true } : {}),
      },
    });
    return {
      kind: list?.kind ?? 'drive#fileList',
      files: snake(list?.files ?? []),
      next_page_token: list?.nextPageToken ?? null,
      incomplete_search: list?.incompleteSearch ?? false,
      ...(fullText && optStr(args, 'order_by') ? { composio_execution_message: 'Drive sorts text searches by relevance, so order_by was ignored.' } : {}),
    };
  },
};

const copyDocument: GoogleTool = {
  name: 'copy_document',
  title: 'Copy document',
  description: 'Copy a Google Doc, for example to fill a template. Without a title the copy is named "Copy of <title>".',
  inputSchema: schema(
    { document_id: s('Document id or Docs URL.'), title: s('Title of the copy.'), include_shared_drives: b('Allow documents in shared drives.', { default: true }) },
    ['document_id'],
  ),
  annotations: WRITE,
  async run(args, ctx) {
    const id = docIdArg(args);
    const title = optStr(args, 'title', 'name');
    const file = await ctx.google.json<Json>({
      method: 'POST',
      url: `${DRIVE}/files/${enc(id)}/copy`,
      query: { supportsAllDrives: optBool(args, 'include_shared_drives', true), fields: '*' },
      body: title ? { name: title } : {},
    });
    const copyId = typeof file?.id === 'string' ? file.id : '';
    return { ...(snake(file) as Json), display_url: docUrl(copyId) };
  },
};

const exportDocumentAsPdf: GoogleTool = {
  name: 'export_document_as_pdf',
  title: 'Export document as PDF',
  description: 'Export a Google Doc as a PDF (Drive limits exports to 10 MB). The file is `file.content_base64`; for a large one pass `--out result.json` to `kortix connectors call`.',
  inputSchema: schema({ file_id: s('Document id or Docs URL.'), filename: s('File name, such as report.pdf.') }, ['file_id']),
  annotations: READ,
  async run(args, ctx) {
    const id = docIdArg(args, 'file_id', 'document_id', 'id');
    const [meta, pdf] = await Promise.all([
      ctx.google.json<{ name?: string }>({ url: `${DRIVE}/files/${enc(id)}`, query: { fields: 'name', supportsAllDrives: true } }).catch(() => null),
      ctx.google.bytes({ url: `${DRIVE}/files/${enc(id)}/export`, query: { mimeType: 'application/pdf' } }),
    ]);
    const name = optStr(args, 'filename') ?? `${meta?.name ?? id}.pdf`;
    const filename = /\.pdf$/i.test(name) ? name : `${name}.pdf`;
    return { file_id: id, mime_type: 'application/pdf', size_bytes: pdf.data.byteLength, display_url: docUrl(id), file: fileOutput(filename, 'application/pdf', pdf.data) };
  },
};

const getDriveFileMetadata: GoogleTool = {
  name: 'get_docs_drive_file_metadata',
  title: 'Get Drive file metadata',
  description: 'Drive metadata of one file: name, type, dates, parents, size and link. `fields` selects others.',
  inputSchema: schema(
    {
      fileId: s('Drive file id.'),
      fields: s('Drive fields to return.', { default: 'id,name,mimeType,description,createdTime,modifiedTime,parents,size,webViewLink' }),
      includeLabels: s('Comma-separated label ids for labelInfo.'),
      includePermissionsForView: s('`published` to include published-view permissions.'),
      supportsAllDrives: b('Include shared drives.', { default: true }),
    },
    ['fileId'],
  ),
  annotations: READ,
  run: (args, ctx) =>
    ctx.google.json({
      url: `${DRIVE}/files/${enc(docIdArg(args, 'fileId', 'file_id', 'id'))}`,
      query: {
        fields: optStr(args, 'fields') ?? 'id,name,mimeType,description,createdTime,modifiedTime,parents,size,webViewLink',
        includeLabels: optStr(args, 'includeLabels'),
        includePermissionsForView: optStr(args, 'includePermissionsForView'),
        supportsAllDrives: optBool(args, 'supportsAllDrives', true),
      },
    }),
};

const listDriveItemPermissions: GoogleTool = {
  name: 'list_drive_item_permissions',
  title: 'List sharing permissions',
  description: 'Who can access a file, folder or shared drive, with their role. Page with pageToken.',
  inputSchema: schema(
    {
      fileId: s('Drive file, folder or shared drive id.'),
      pageSize: i('Permissions per page, 1–100.'),
      pageToken: s('nextPageToken of the previous page. `page_token` is an alias.'),
      fields: s('Drive fields to return.', { default: 'kind,nextPageToken,permissions(id,type,role,emailAddress,displayName,domain,allowFileDiscovery,expirationTime,deleted,pendingOwner,permissionDetails)' }),
      supportsAllDrives: b('Include shared drives.', { default: true }),
      useDomainAdminAccess: b('Use Workspace administrator access for a shared drive.', { default: false }),
      includePermissionsForView: s('`published` to include published-view permissions.'),
    },
    ['fileId'],
  ),
  annotations: READ,
  async run(args, ctx) {
    const list = await ctx.google.json<Json>({
      url: `${DRIVE}/files/${enc(docIdArg(args, 'fileId', 'file_id', 'id'))}/permissions`,
      query: {
        pageSize: optInt(args, 'pageSize', undefined, 100) ?? optInt(args, 'page_size', undefined, 100),
        pageToken: optStr(args, 'pageToken', 'page_token'),
        fields:
          optStr(args, 'fields') ??
          'kind,nextPageToken,permissions(id,type,role,emailAddress,displayName,domain,allowFileDiscovery,expirationTime,deleted,pendingOwner,permissionDetails)',
        supportsAllDrives: optBool(args, 'supportsAllDrives', true),
        useDomainAdminAccess: optBool(args, 'useDomainAdminAccess', false) || undefined,
        includePermissionsForView: optStr(args, 'includePermissionsForView'),
      },
    });
    return { kind: list?.kind ?? 'drive#permissionList', permissions: list?.permissions ?? [], nextPageToken: list?.nextPageToken ?? null };
  },
};

const createDriveFile: GoogleTool = {
  name: 'create_drive_file',
  title: 'Create Drive item',
  description: 'Create an empty Drive item: a folder (mime_type application/vnd.google-apps.folder), a shortcut (shortcut_target_id), a blank Google Doc, or a metadata-only file.',
  inputSchema: schema({
    name: s('Item name.'),
    mime_type: s('Drive MIME type, such as application/vnd.google-apps.folder or application/vnd.google-apps.document.'),
    parent_folder_id: s('Folder to create it in; My Drive root when omitted.'),
    description: s('Description.'),
    starred: b('Star the item.'),
    properties: anyObj('Public custom properties.'),
    app_properties: anyObj('Private app properties.'),
    shortcut_target_id: s('For a shortcut: the id of the file it points to.'),
    fields: s('Drive fields to return.', { default: 'id,name,mimeType,description,starred,parents,properties,appProperties,shortcutDetails,createdTime,modifiedTime,webViewLink' }),
    supports_all_drives: b('Allow shared drives.', { default: true }),
  }),
  annotations: WRITE,
  run(args, ctx) {
    const parent = optStr(args, 'parent_folder_id');
    const shortcut = optStr(args, 'shortcut_target_id');
    const body: Json = {
      name: optStr(args, 'name'),
      mimeType: optStr(args, 'mime_type', 'mimeType') ?? (shortcut ? SHORTCUT_MIME : undefined),
      description: optStr(args, 'description'),
      starred: typeof args.starred === 'boolean' ? args.starred : undefined,
      parents: parent ? [parent] : undefined,
      properties: optObj(args, 'properties'),
      appProperties: optObj(args, 'app_properties'),
      shortcutDetails: shortcut ? { targetId: shortcut } : undefined,
    };
    return ctx.google.json({
      method: 'POST',
      url: `${DRIVE}/files`,
      query: {
        fields: optStr(args, 'fields') ?? 'id,name,mimeType,description,starred,parents,properties,appProperties,shortcutDetails,createdTime,modifiedTime,webViewLink',
        supportsAllDrives: optBool(args, 'supports_all_drives', true),
      },
      body,
    });
  },
};

/** A Drive multipart/related upload body: JSON metadata, then the file bytes. */
function multipart(metadata: Json, file: FileInput): { contentType: string; data: Uint8Array } {
  const boundary = `kortix-${crypto.randomUUID()}`;
  const encoder = new TextEncoder();
  const head = encoder.encode(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${file.mimeType}\r\n\r\n`);
  const tail = encoder.encode(`\r\n--${boundary}--\r\n`);
  const data = new Uint8Array(head.byteLength + file.data.byteLength + tail.byteLength);
  data.set(head, 0);
  data.set(file.data, head.byteLength);
  data.set(tail, head.byteLength + file.data.byteLength);
  return { contentType: `multipart/related; boundary=${boundary}`, data };
}

const uploadDriveFile: GoogleTool = {
  name: 'upload_drive_file',
  title: 'Upload file to Drive',
  description: 'Upload a file of up to 5 MiB to Drive. Pass the file as base64 `content` (or a Kortix attachment reference) or a public https `url`.',
  inputSchema: schema(
    {
      file: { ...FILE_ITEM_SCHEMA, description: 'The file: {filename, content (base64) | url, content_type}.' },
      name: s('Drive file name; the file\'s own name when omitted.'),
      mime_type: s('MIME type; the file\'s type when omitted.'),
      description: s('Description.'),
      parent_folder_id: s('Folder to upload into; My Drive root when omitted.'),
      fields: s('Drive fields to return.', { default: 'id,name,mimeType,description,parents,size,createdTime,modifiedTime,webViewLink' }),
      supports_all_drives: b('Allow shared drives.', { default: true }),
    },
    ['file'],
  ),
  annotations: WRITE,
  async run(args, ctx) {
    const file = await resolveFile(args.file, 'file');
    if (file.data.byteLength > SIMPLE_UPLOAD_MAX_BYTES) throw new ToolInputError(`file is ${file.data.byteLength} bytes; this tool uploads at most ${SIMPLE_UPLOAD_MAX_BYTES}`);
    const mimeType = optStr(args, 'mime_type') ?? file.mimeType;
    const parent = optStr(args, 'parent_folder_id');
    const metadata: Json = { name: optStr(args, 'name') ?? file.filename, mimeType, ...(optStr(args, 'description') ? { description: optStr(args, 'description') } : {}), ...(parent ? { parents: [parent] } : {}) };
    const body = multipart(metadata, { ...file, mimeType });
    return ctx.google.json({
      method: 'POST',
      url: DRIVE_UPLOAD,
      query: {
        uploadType: 'multipart',
        fields: optStr(args, 'fields') ?? 'id,name,mimeType,description,parents,size,createdTime,modifiedTime,webViewLink',
        supportsAllDrives: optBool(args, 'supports_all_drives', true),
      },
      rawBody: body,
    });
  },
};

// ─── Sheets reads ───────────────────────────────────────────────────────────

const getSpreadsheetValues: GoogleTool = {
  name: 'get_docs_spreadsheet_values',
  title: 'Read spreadsheet range',
  description: 'Read the cell values of one range of a Google Sheet, such as `Sheet1!A1:D100`.',
  inputSchema: schema(
    {
      spreadsheet_id: s('Spreadsheet id (from its URL).'),
      range: s('A1 range with the sheet name when needed, such as Sheet1!A1:D100.'),
      major_dimension: s('ROWS or COLUMNS.', { enum: ['ROWS', 'COLUMNS'], default: 'ROWS' }),
      value_render_option: s('How values are shown.', { enum: ['FORMATTED_VALUE', 'UNFORMATTED_VALUE', 'FORMULA'], default: 'FORMATTED_VALUE' }),
      date_time_render_option: s('Dates with UNFORMATTED_VALUE.', { enum: ['SERIAL_NUMBER', 'FORMATTED_STRING'], default: 'SERIAL_NUMBER' }),
    },
    ['spreadsheet_id', 'range'],
  ),
  annotations: READ,
  async run(args, ctx) {
    const id = docIdArg(args, 'spreadsheet_id', 'spreadsheetId');
    const majorDimension = optStr(args, 'major_dimension') ?? 'ROWS';
    const result = await ctx.google.json<{ range?: string; values?: unknown[][]; majorDimension?: string }>({
      url: `${SHEETS}/${enc(id)}/values/${enc(reqStr(args, 'range'))}`,
      query: {
        majorDimension,
        valueRenderOption: optStr(args, 'value_render_option') ?? 'FORMATTED_VALUE',
        dateTimeRenderOption: optStr(args, 'date_time_render_option') ?? 'SERIAL_NUMBER',
      },
    });
    return { spreadsheet_id: id, range: result?.range ?? reqStr(args, 'range'), major_dimension: result?.majorDimension ?? majorDimension, values: result?.values ?? [] };
  },
};

const listSpreadsheetCharts: GoogleTool = {
  name: 'list_spreadsheet_charts',
  title: 'List spreadsheet charts',
  description: 'List every chart of a Google Sheet with its chartId, sheet and spec, for example to embed one in a document.',
  inputSchema: schema({ spreadsheet_id: s('Spreadsheet id (from its URL).') }, ['spreadsheet_id']),
  annotations: READ,
  async run(args, ctx) {
    const id = docIdArg(args, 'spreadsheet_id', 'spreadsheetId');
    const sheet = await ctx.google.json<Json>({
      url: `${SHEETS}/${enc(id)}`,
      query: { fields: 'spreadsheetId,spreadsheetUrl,properties(title,locale,timeZone),sheets(properties(sheetId,title,index),charts)' },
    });
    return { ...sheet, display_url: (sheet?.spreadsheetUrl as string | undefined) ?? `https://docs.google.com/spreadsheets/d/${id}/edit` };
  },
};

export const DOCS_TOOLS: readonly GoogleTool[] = [
  getDocumentPlaintext,
  updateDocumentMarkdown,
  createDocumentMarkdown,
  getDocumentById,
  replaceAllText,
  searchDocuments,
  updateExistingDocument,
  exportDocumentAsPdf,
  listDriveItemPermissions,
  getDriveFileMetadata,
  getDocumentEndIndex,
  deleteContentRange,
  updateDocumentSectionMarkdown,
  createDriveFile,
  createDocument,
  createDocument2,
  copyDocument,
  insertTextAction,
  createParagraphBullets,
  deleteParagraphBullets,
  insertPageBreak,
  insertTableAction,
  createAndPopulateTable,
  insertTableRow,
  insertTableColumn,
  deleteTableRow,
  deleteTableColumn,
  unmergeTableCells,
  updateTableRowStyle,
  insertTextInTableCell,
  insertInlineImage,
  insertImageInTableCell,
  replaceImage,
  createHeader,
  createFooter,
  deleteHeaderFooter('header'),
  deleteHeaderFooter('footer'),
  createFootnote,
  createNamedRange,
  deleteNamedRange,
  createTab,
  deleteTab,
  updateTabProperties,
  updateDocumentStyle,
  updateDocumentBatch,
  uploadDriveFile,
  getSpreadsheetValues,
  listSpreadsheetCharts,
];
