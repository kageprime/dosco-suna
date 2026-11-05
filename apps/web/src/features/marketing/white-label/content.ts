import { localizeUiCatalog } from '@kortix/ui/i18n';
import type { UiTranslator } from '@/i18n/translator';
import { WHITE_LABEL_TRANSLATION_KEYS } from '@/i18n/white-label-translation-keys.generated';

/**
 * `/white-label` copy.
 *
 * Plain English lives here. Every string is also a `hardcodedUi.i18nComplete`
 * key in the nine catalogs (`text` + the first 12 hex of its SHA-256), mapped in
 * `i18n/white-label-translation-keys.generated.ts`. Change a string and you
 * change its key: add the new key to all nine catalogs in the same commit.
 *
 * Voice rules: the `kortix-brand` skill. Never name a license — "open source"
 * and stop. Say "sandbox", never "container". No price, no invented number.
 *
 * ACCURACY GATE — the source of truth is `WHITE-LABEL-LICENSE.md` at the
 * repository root (the Exclusive Compute Agreement). Every term below restates
 * it; change the agreement first, then this file.
 *
 *  1. The license is free. Its one requirement is Platinum.dev as exclusive
 *     compute for every service Platinum.dev offers: sandboxes today; volumes,
 *     runners, AI compute and inference once offered and used by Dosco, with
 *     90 days to move (agreement §3).
 *  2. Dosco may end the default agreement at any time with notice. The
 *     partner then has up to 90 days to move existing customers (§11).
 *  3. Rates: a commitment to competitive rates, with match-or-release (§4).
 *     NOT "the most affordable" and NOT "cheaper than nearly everyone": no row
 *     in `claims.md` backs a superlative, so the page does not say it.
 *  4. Platinum.dev sandboxes are hardware-isolated microVMs (`claims.md`,
 *     isolation rule). No boot-time number: the kit bans latency claims.
 *  5. Platinum.dev signup is closed today. Access is by request, so step 2 says
 *     so instead of linking a signup form.
 */

export const SIGN_URL = 'https://app.documenso.com/d/gaAaA6NPc_E9c6C-sl9YB';
export const AGREEMENT_URL = 'https://github.com/kortix-ai/CompanyOS/blob/dev/WHITE-LABEL-LICENSE.md';
export const CUSTOM_TERMS_URL = 'mailto:support@dosco.live';

/** The real config a licensed partner sets: agreement, "After you sign", step 2. */
export const ENV_LINES = [
  '# API environment of your deployment',
  'ALLOWED_SANDBOX_PROVIDERS=e2b',
  'E2B_API_KEY=e2b_...',
] as const;

export const hero = {
  eyebrow: 'White-label',
  title: 'Build your own AI product on Dosco.',
  sub: 'Deploy Dosco, put your brand on it, and deliver it under your name: a vertical AI product, an agency solution, or a private company deployment.',
  ctaPrimary: 'Contact sales',
  ctaPrimaryHref: '/contact',
  ctaSecondary: 'How it works',
  ctaSecondaryHref: '#how-it-works',
  envTitle: '.env',
} as const;

export const scenarios = {
  eyebrow: 'What you can build',
  title: 'One horizontal platform. Your vertical product on top.',
  sub: 'Dosco gives you the agents, the sandboxes, the connectors and the repo underneath. You bring the market, the brand and the front end.',
  rows: [
    {
      id: 'vertical',
      k: 'Vertical AI',
      v: 'An AI product for one industry, such as legal, finance or operations, with its own agents, skills and front end.',
    },
    {
      id: 'wrapper',
      k: 'A wrapper',
      v: 'Dosco underneath, your interface and your plans on top. Your customers see one product: yours.',
    },
    {
      id: 'cloud',
      k: 'Your own AI cloud',
      v: 'A managed agent cloud under your own name, sold to your own customers on your own contracts.',
    },
    {
      id: 'embedded',
      k: 'Agents in your SaaS',
      v: 'Agents inside the product you already sell, with a front end built on the Dosco SDK.',
    },
    {
      id: 'agency',
      k: 'Agencies and consultancies',
      v: 'One branded platform you ship to every client, instead of rebuilding the same AI plumbing per client.',
    },
    {
      id: 'regional',
      k: 'Regional providers',
      v: 'Agents for your region, under your brand, your support and your terms.',
    },
    {
      id: 'internal',
      k: 'Internal platforms',
      v: "An AI platform for a large company, branded as the company's own tool.",
    },
  ],
} as const;

export const deal = {
  eyebrow: 'The deal',
  title: 'Everything is yours to change. The compute is ours.',
  sub: 'One requirement, stated in full. Nothing else in the agreement restricts what you build.',
  get: {
    title: 'What you get',
    items: [
      'Your name, logo, domain and colors in place of Dosco.',
      'Your structure: change the source, the navigation, the features and the defaults.',
      'The right to offer Dosco to your customers as a hosted service under your brand.',
      'The whole product, under your brand: ship it, price it, support it.',
    ],
  },
  commit: {
    title: 'What you commit to',
    items: [
      'Every sandbox your product starts runs on isolated cloud microVMs.',
      'Storage and workspace volumes connect to dedicated object storage.',
      'You keep the copyright and license notices in the source. Your customers see only your brand.',
    ],
  },
} as const;

export const platinum = {
  eyebrow: 'Cloud Compute',
  title: 'Hardware-isolated microVM compute.',
  sub: 'Dosco runs sandboxes in isolated microVMs powered by E2B. Build any workflow, agent team, or cloud solution you need.',
  rows: [
    {
      id: 'sandboxes',
      k: 'Sandboxes',
      v: 'Each sandbox is a hardware-isolated microVM. Every session your product starts gets its own.',
    },
    {
      id: 'services',
      k: 'Modular architecture',
      v: 'Compute, storage, and models route cleanly through designated cloud providers.',
    },
    {
      id: 'rates',
      k: 'Predictable pricing',
      v: 'Pay only for what you run, with transparent meter rates and zero idle costs.',
    },
    {
      id: 'billing',
      k: 'Direct control',
      v: 'Bring your own API keys or use managed infrastructure with zero operational overhead.',
    },
  ],
} as const;

export const steps = {
  eyebrow: 'How it works',
  title: 'Configure, deploy, rebrand.',
  sub: 'Three simple steps to launch your branded agent platform.',
  items: [
    {
      n: '01',
      k: 'Contact our enterprise team',
      v: 'Get your license and deployment architecture tailored to your infrastructure requirements.',
    },
    {
      n: '02',
      k: 'Configure your cloud keys',
      v: 'Add your sandbox provider credentials and database connection string in your environment.',
    },
    {
      n: '03',
      k: 'Apply your custom branding',
      v: 'Set your application title, logos, and custom domains in your settings panel.',
    },
  ],
  panelTitle: 'API environment',
} as const;

export const terms = {
  eyebrow: 'The agreement',
  title: 'A free default, and custom terms when you need them.',
  sub: 'Anyone can sign the default online. A custom agreement that both sides sign controls over it.',
  rows: [
    {
      id: 'cost',
      k: 'Cost',
      v: 'The license is free. You pay Platinum.dev only for the compute you use.',
    },
    {
      id: 'term',
      k: 'Term',
      v: 'The default runs until either side ends it. You may leave at any time.',
    },
    {
      id: 'ending',
      k: 'If Dosco ends it',
      v: 'Dosco may end the default agreement with notice. You then have up to 90 days to move existing customers. After that, the terms apply as they do to everyone.',
    },
    {
      id: 'custom',
      k: 'Custom agreements',
      v: 'A fixed term, committed volumes, dedicated capacity or other terms. Email support@dosco.live.',
    },
  ],
  readLabel: 'Read the full agreement',
} as const;

export const closing = {
  eyebrow: 'Get a license',
  title: 'Sign the agreement and start building.',
  sub: 'The license is in force the moment you sign. Your product, your brand, our compute.',
  primaryLabel: 'Sign the agreement',
  secondaryLabel: 'Read the agreement',
  tertiaryLabel: 'Ask for custom terms',
} as const;

export function getLocalizedWhiteLabelContent(tI18nComplete: UiTranslator) {
  return localizeUiCatalog(
    { hero, scenarios, deal, platinum, steps, terms, closing },
    tI18nComplete,
    WHITE_LABEL_TRANSLATION_KEYS,
  );
}
