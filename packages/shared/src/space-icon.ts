/**
 * A space's icon, and the icon a new space gets from its name.
 *
 * A space wears one icon: an emoji XOR a named glyph from the project glyph
 * catalogue (`project-glyphs.ts`). The value is a union, the same shape the
 * web picker (`ProjectIconValue`) holds, so a host cannot build a value that
 * sets both.
 *
 * `suggestSpaceIcon` runs on every space the API creates without an icon, and
 * in clients for a space that has none (spaces created before icons existed).
 * It is pure and deterministic: the same name always gives the same icon, on
 * the server and in every client.
 */
import { PROJECT_GLYPH_COLORS, type ProjectGlyph, type ProjectGlyphName } from './project-glyphs';

export type SpaceIcon = { emoji: string } | { glyph: ProjectGlyph };

/**
 * Word stem -> glyph. A name word matches a stem when it equals the stem or
 * starts with it (`market` matches `marketing`, `markets`). Order inside the
 * table does not matter; the FIRST WORD of the name that matches wins, so
 * "Sales Q3 report" is Sales, not Report.
 *
 * Every value must be a catalogue name: `space-icon.test.ts` checks each one
 * with `isProjectGlyphName`, so a typo fails a test instead of drawing nothing.
 */
const STEM_GLYPHS: ReadonlyArray<readonly [ProjectGlyphName, readonly string[]]> = [
  // Go-to-market
  ['Megaphone', ['market', 'campaign', 'launch', 'announce', 'promo', 'brand', 'growth', 'advert']],
  ['Handshake', ['sale', 'deal', 'partner', 'crm', 'leads', 'prospect', 'outreach', 'bizdev', 'bd']],
  ['Headset', ['support', 'helpdesk', 'ticket', 'customer', 'cs', 'success', 'service']],
  ['Users', ['team', 'people', 'hr', 'hiring', 'recruit', 'talent', 'onboard', 'staff', 'org', 'community']],
  ['ChatsCircle', ['chat', 'discuss', 'social', 'slack', 'comms', 'communic', 'feedback']],
  ['Envelope', ['email', 'mail', 'newsletter', 'inbox']],
  // Product and engineering
  ['Code', ['code', 'engineer', 'dev', 'backend', 'frontend', 'api', 'sdk', 'program', 'software', 'platform']],
  ['Bug', ['bug', 'fix', 'qa', 'issue', 'incident', 'triage', 'debug']],
  ['Rocket', ['ship', 'release', 'deploy', 'startup', 'mvp', 'beta']],
  ['Cube', ['product', 'feature', 'roadmap', 'spec']],
  ['GitBranch', ['git', 'repo', 'branch', 'merge', 'pr']],
  ['Database', ['data', 'database', 'sql', 'warehouse', 'etl', 'pipeline']],
  ['Cloud', ['cloud', 'infra', 'devops', 'aws', 'server', 'ops']],
  ['Robot', ['ai', 'agent', 'bot', 'llm', 'model', 'ml', 'automat', 'gpt', 'claude']],
  ['ShieldCheck', ['secur', 'complian', 'legal', 'privacy', 'audit', 'risk', 'soc', 'gdpr']],
  ['DeviceMobile', ['mobile', 'ios', 'android', 'app']],
  ['Browser', ['web', 'site', 'landing', 'seo', 'page']],
  ['Terminal', ['cli', 'terminal', 'script', 'shell']],
  // Design and content
  ['Palette', ['design', 'ui', 'ux', 'figma', 'visual', 'creative', 'art']],
  ['PenNib', ['write', 'writing', 'copy', 'content', 'blog', 'article', 'draft', 'story', 'editor']],
  ['VideoCamera', ['video', 'film', 'youtube', 'record', 'stream', 'podcast']],
  ['Image', ['photo', 'image', 'picture', 'graphic']],
  ['FileText', ['doc', 'docs', 'documentation', 'wiki', 'guide', 'manual', 'note', 'report']],
  ['PresentationChart', ['deck', 'pitch', 'present', 'slide', 'board']],
  // Numbers
  ['ChartLineUp', ['analytic', 'metric', 'kpi', 'dashboard', 'insight', 'stat', 'track', 'perform']],
  ['CurrencyDollar', ['financ', 'money', 'budget', 'revenue', 'invoice', 'billing', 'account', 'tax', 'pricing', 'payroll', 'fund', 'invest']],
  ['ShoppingCart', ['shop', 'store', 'ecommerce', 'commerce', 'order', 'retail']],
  ['Package', ['logistic', 'inventory', 'supply', 'deliver', 'parcel']],
  // Planning and research
  ['Calendar', ['plan', 'schedul', 'calendar', 'event', 'meeting', 'weekly', 'daily', 'sprint']],
  ['Kanban', ['project', 'task', 'todo', 'backlog', 'kanban']],
  ['Strategy', ['strategy', 'okr', 'goal', 'vision', 'exec', 'leader']],
  ['MagnifyingGlass', ['research', 'search', 'discover', 'explor', 'investig', 'analysis', 'compet']],
  ['Flask', ['experiment', 'lab', 'test', 'science', 'prototype', 'poc', 'sandbox', 'playground']],
  ['Lightbulb', ['idea', 'brainstorm', 'innovat', 'inspir', 'think']],
  ['GraduationCap', ['learn', 'course', 'study', 'school', 'train', 'educat', 'class', 'tutor']],
  ['BookOpen', ['book', 'read', 'library', 'knowledge', 'kb']],
  // Life
  ['House', ['home', 'house', 'family', 'personal', 'life']],
  ['AirplaneTilt', ['travel', 'trip', 'flight', 'vacation', 'holiday']],
  ['Heartbeat', ['health', 'fitness', 'workout', 'medical', 'wellness', 'gym']],
  ['MusicNotes', ['music', 'song', 'audio', 'sound']],
  ['GameController', ['game', 'gaming', 'play', 'fun']],
  ['ForkKnife', ['food', 'recipe', 'cook', 'restaurant', 'meal']],
  ['Briefcase', ['work', 'job', 'business', 'office', 'client', 'agency', 'consult']],
  ['Sparkle', ['general', 'misc', 'random', 'scratch', 'new']],
];

/** Neutral glyphs for a name that matches no stem; picked by the name's hash. */
const FALLBACK_GLYPHS: readonly ProjectGlyphName[] = [
  'Cube',
  'Sparkle',
  'Lightning',
  'Star',
  'Hexagon',
  'Diamond',
  'Planet',
  'Leaf',
  'Compass',
  'Flag',
];

/** Every palette colour except `grey`: a new space should not look unset. */
const SUGGESTED_COLORS = PROJECT_GLYPH_COLORS.filter((color) => color !== 'grey');

/** FNV-1a, 32 bit: stable across runtimes, unlike any engine string hash. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Lower-case words, with camelCase and digits split: "Q3SalesDeck" -> q, 3, sales, deck. */
function words(name: string): string[] {
  return name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** A stem of two or three letters must equal the word: `ai` is not `aid`, `pr` is not `print`. */
function wordMatches(word: string, stem: string): boolean {
  return stem.length <= 3 ? word === stem : word.startsWith(stem);
}

function glyphForName(name: string): ProjectGlyphName | null {
  for (const word of words(name)) {
    for (const [glyph, stems] of STEM_GLYPHS) {
      if (stems.some((stem) => wordMatches(word, stem))) return glyph;
    }
  }
  return null;
}

/**
 * The icon a space named `name` gets when nobody picked one: a glyph that
 * fits the name's first meaningful word, else a neutral glyph, in a colour
 * from the name's hash. Same name, same icon, everywhere.
 */
export function suggestSpaceIcon(name: string): { glyph: ProjectGlyph } {
  const key = name.trim().toLowerCase();
  const h = hash(key);
  const glyph = glyphForName(key) ?? FALLBACK_GLYPHS[h % FALLBACK_GLYPHS.length]!;
  const color = SUGGESTED_COLORS[(h >>> 8) % SUGGESTED_COLORS.length]!;
  return { glyph: { name: glyph, color } };
}

/** The table, for the catalogue test. */
export const SPACE_ICON_STEM_GLYPHS = STEM_GLYPHS;
export const SPACE_ICON_FALLBACK_GLYPHS = FALLBACK_GLYPHS;
