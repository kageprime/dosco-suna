/**
 * Work people actually do, written as agent loops. The role cards on the home
 * page come from shipped starter templates; these examples do not claim a
 * template exists. They describe the setup a person can ask for, with a
 * signal, the steps an agent works through and a draft waiting for approval.
 *
 * The selection follows public research, not guesswork:
 *  - ILO Working Paper 140 (2025): one in four workers is in an occupation
 *    with some generative-AI exposure; clerical work is the most exposed.
 *  - Anthropic Economic Index (Feb and Sep 2025): coding dominates usage, but
 *    arts/design/media, education, office admin and business tasks are all
 *    present; 36% of occupations use AI for at least a quarter of their tasks.
 *  - Adobe Creators' Toolkit Report (2025): 86% of 16,000 creators across
 *    eight countries use creative generative AI.
 *  - UNCTAD Digital Economy Report 2024: business e-commerce sales reached
 *    $27 trillion in 2022, up nearly 60% from 2016.
 *  - IAB SEA+India Social Commerce Playbook (2025) and ADB Asia SME Monitor
 *    2025: phone-first buying and small sellers across Asia and the Pacific.
 */

export type UseCaseGroup = 'Run a store' | 'Professional work' | 'Creative work' | 'Learn and plan';

export const USE_CASE_GROUPS: readonly UseCaseGroup[] = [
  'Run a store',
  'Professional work',
  'Creative work',
  'Learn and plan',
];

export interface UseCaseView {
  id: string;
  group: UseCaseGroup;
  /** The role as a person names it. */
  role: string;
  /** One sentence on the loop, in the reader's words. */
  line: string;
  /** Where the signal arrives, as a session card title. */
  source: string;
  /** The request itself. */
  signal: string;
  /** The work the agent steps through. Kept short for the session card. */
  steps: readonly string[];
  /** The draft that waits for a person. */
  result: string;
}

export const USE_CASES: readonly UseCaseView[] = [
  {
    id: 'store-catalog',
    group: 'Run a store',
    role: 'Product catalogue',
    line: 'A new product becomes a listing with copy, variants and price, checked against your catalogue.',
    source: 'New product in sheet',
    signal: 'Ceramic mug · 3 sizes · 4 colours',
    steps: ['read the product sheet', 'match your listing format', 'write copy and variants', 'check price and stock'],
    result: 'Listing draft ready for your review',
  },
  {
    id: 'store-customer',
    group: 'Run a store',
    role: 'Customer care',
    line: 'Order questions and return requests answered in draft with the order record attached.',
    source: 'Inbox · order questions',
    signal: 'Where is my order? #10482',
    steps: ['read the order record', 'check delivery status', 'draft the reply', 'flag the exception'],
    result: 'Reply draft with the order attached',
  },
  {
    id: 'store-ads',
    group: 'Run a store',
    role: 'Ads and campaigns',
    line: 'Ad and social copy drafted from the catalogue, with the last campaign kept for comparison.',
    source: 'Campaign brief',
    signal: 'Spring launch · 3 products · €200 budget',
    steps: ['read the brief', 'pick the products', 'write ad variants', 'draft the weekly report'],
    result: 'Ad variants and report draft',
  },
  {
    id: 'store-books',
    group: 'Run a store',
    role: 'Bookkeeping',
    line: 'Invoices and receipts matched to orders; the exceptions are listed for you.',
    source: 'Inbox · invoices',
    signal: '12 supplier invoices this week',
    steps: ['read each invoice', 'match to purchase orders', 'flag missing receipts', 'draft the summary'],
    result: 'Reconciliation summary and exceptions',
  },
  {
    id: 'store-restock',
    group: 'Run a store',
    role: 'Restocking',
    line: 'Low-stock alerts become supplier messages with quantities and delivery dates.',
    source: 'Stock alert',
    signal: '3 items below reorder point',
    steps: ['read the stock report', 'check supplier terms', 'draft purchase messages', 'flag the long lead time'],
    result: 'Three supplier drafts waiting to send',
  },
  {
    id: 'legal-review',
    group: 'Professional work',
    role: 'Legal first pass',
    line: 'A new contract compared with your template; clauses flagged and redlines drafted.',
    source: 'New contract',
    signal: 'Supplier agreement · 14 pages',
    steps: ['read the contract', 'compare with your template', 'flag changed clauses', 'draft the redlines'],
    result: 'Clause notes and redline draft',
  },
  {
    id: 'finance-close',
    group: 'Professional work',
    role: 'Finance close',
    line: 'Month-end numbers reconciled, variance notes written, the report drafted.',
    source: 'Month end',
    signal: 'September close · 5 accounts',
    steps: ['pull the ledger', 'match the accounts', 'write variance notes', 'draft the report'],
    result: 'Close report draft with notes',
  },
  {
    id: 'market-research',
    group: 'Professional work',
    role: 'Market research',
    line: 'Sources read and compared into a short brief on the markets you follow.',
    source: 'Morning brief',
    signal: '3 sectors · 12 sources',
    steps: ['collect the sources', 'compare the claims', 'flag what changed', 'write the brief'],
    result: 'One-page brief with source links',
  },
  {
    id: 'back-office',
    group: 'Professional work',
    role: 'Back office',
    line: 'Vendor follow-ups, form entries and status updates prepared from the inbox.',
    source: 'Shared inbox',
    signal: '18 unread · 6 follow-ups due',
    steps: ['triage the inbox', 'draft the follow-ups', 'fill the form entries', 'list the blockers'],
    result: 'Drafts and a short action list',
  },
  {
    id: 'graphic-design',
    group: 'Creative work',
    role: 'Graphic design',
    line: 'A brief becomes layout variants, crops and sizes for each channel.',
    source: 'Design brief',
    signal: 'Launch banner · 4 sizes',
    steps: ['read the brief', 'pick the visual direction', 'lay out the variants', 'export the sizes'],
    result: 'Layout variants ready to review',
  },
  {
    id: 'animation',
    group: 'Creative work',
    role: 'Animation',
    line: 'A script becomes a storyboard and motion notes for the first pass.',
    source: 'Script',
    signal: '30s explainer · 6 scenes',
    steps: ['read the script', 'split into scenes', 'draft the storyboard', 'write motion notes'],
    result: 'Storyboard and motion notes',
  },
  {
    id: 'web-updates',
    group: 'Creative work',
    role: 'Website updates',
    line: 'Copy and layout changes become a pull request on your site.',
    source: 'Change request',
    signal: 'Update pricing and FAQ',
    steps: ['read the request', 'find the files', 'make the edits', 'open the change request'],
    result: 'Change request waiting for you',
  },
  {
    id: 'lesson-prep',
    group: 'Learn and plan',
    role: 'Lesson prep',
    line: 'A lesson plan and exercises built for the level you teach.',
    source: 'Lesson request',
    signal: 'Algebra · grade 9 · 45 min',
    steps: ['set the learning goal', 'draft the plan', 'build the exercises', 'write the answer key'],
    result: 'Lesson plan and exercise set',
  },
  {
    id: 'research-brief',
    group: 'Learn and plan',
    role: 'Research and reporting',
    line: 'A question becomes a sourced brief with claims you can check.',
    source: 'Research request',
    signal: 'Compare 4 suppliers',
    steps: ['collect the sources', 'compare the offers', 'note the gaps', 'write the brief'],
    result: 'Brief with links and caveats',
  },
];

/** One example per group keeps the moving strip short enough to read. */
const FEATURED_IDS = new Set([
  'store-catalog',
  'store-customer',
  'legal-review',
  'graphic-design',
  'lesson-prep',
]);

export function useCaseViews(): readonly UseCaseView[] {
  return USE_CASES;
}

export function featuredUseCaseViews(): readonly UseCaseView[] {
  return USE_CASES.filter((useCase) => FEATURED_IDS.has(useCase.id));
}
