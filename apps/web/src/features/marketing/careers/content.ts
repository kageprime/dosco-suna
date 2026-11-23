/**
 * `/careers` copy. The page is a job board, not an essay: the openings, the
 * bar, and how to apply. Nothing else belongs here Ã¢â‚¬â€ the thesis lives on
 * `/about`.
 *
 * Plain English lives here, not in `apps/web/translations/*.json`, so the copy
 * can iterate before paying the 8-locale parity gate (`pnpm i18n:translations`).
 *
 * Voice rules: the `Dosco-brand` skill.
 *
 * ACCURACY GATE for this page specifically:
 *  - INVENT NOTHING about employment. No salary band, no equity, no benefits,
 *    no headcount, no remote policy beyond the locations below.
 *    Locations (founder, 2026-11-19): Founding GTM is San Francisco, New York
 *    or US remote; MTS and FDE are Belgrade, San Francisco, New York or remote.
 *  - The three openings (Founding GTM, MTS, FDE, 2026-11-18) are the founder's own list and
 *    order. The board names the role and its location only: no summary line, no role pages,
 *    no spec. A spec belongs in a conversation.
 *  - Applications go through `ApplyModal`, which posts to the same
 *    `/api/demo-request` pipeline as "Book your demo". There is no ATS and no
 *    jobs@ alias Ã¢â‚¬â€ do not invent one. The three direct links (email, X,
 *    LinkedIn) are the ones this page already carried.
 *  - There is NO file upload on that pipeline (JSON in, one blob into
 *    `contact_forms`). Ask for a LINK to a CV or portfolio. Never promise an
 *    attachment.
 *  - Competitor names, exactly: **Claude Cowork** (one word, lowercase `w`) and
 *    **ChatGPT Work** (two words).
 *  - Never name a licence Ã¢â‚¬â€ "open source" and stop. Never claim a certification.
 *  - No culture-page filler. If a sentence restates the one above it, cut it.
 */

export const hero = {
  title: 'Open positions.',
  lead: 'Belgrade, New York, San Francisco or remote.',
  description: 'A small team building the open-source CompanyOS.',
  roleLabel: 'Role',
  locationLabel: 'Location',
  ctaPrimary: 'Apply',
  ctaSecondary: 'Why Dosco exists',
  ctaSecondaryHref: '/about',
} as const;

/** The board: the role, its full name and its location. Deliberately broad Ã¢â‚¬â€ the rest is a
 *  conversation. */
export const openings = [
  {
    id: 'gtm',
    name: 'Founding GTM',
    full: 'Enterprise & Partners',
    location: 'SF, NYC or US remote',
  },
  {
    id: 'mts',
    name: 'MTS',
    full: 'Member of Technical Staff',
    location: 'Belgrade, SF, NYC, Remote',
  },
  {
    id: 'fde',
    name: 'FDE',
    full: 'Forward Deployed Engineer',
    location: 'Belgrade, SF, NYC, Remote',
  },
] as const;

export const bar = {
  title: 'What we look for.',
  titleMuted: 'Ownership, agency and skill.',
  lead: 'Each person owns a part of the product end to end.',
  items: [
    {
      id: 'ownership',
      title: 'Ownership',
      body: 'You take a problem from the first report to a fix in production, and you stay with it after the release.',
    },
    {
      id: 'agency',
      title: 'Agency',
      body: 'You find the next step without a ticket. You ask for help when you need it.',
    },
    {
      id: 'skill',
      title: 'Skill',
      body: 'Your past work shows it: products, companies, open-source projects or tools you built for yourself.',
    },
  ],
} as const;

export const apply = {
  title: 'Tell us what you have built.',
  titleMuted: 'We read every application.',
  body: 'One open question and a link to your work. No cover letter.',
  cta: 'Apply',
  directLead: 'Or write to Marko directly:',
  links: [
    { id: 'email', label: 'marko@Dosco.com', href: 'mailto:marko@Dosco.com', external: false },
    { id: 'x', label: '@markokraemer', href: 'https://x.com/markokraemer', external: true },
    {
      id: 'linkedin',
      label: 'linkedin.com/in/markokraemer',
      href: 'https://linkedin.com/in/markokraemer',
      external: true,
    },
  ],
} as const;

/** Copy for `ApplyModal`. */
export const applyForm = {
  title: 'Apply to Dosco',
  description: 'One open question and a link to your work.',
  areaLabel: 'Which opening',
  areaPlaceholder: 'Pick the closest one',
  areaOptions: [
    'Founding GTM Ã¢â‚¬â€ Enterprise & Partners',
    'MTS Ã¢â‚¬â€ Member of Technical Staff',
    'FDE Ã¢â‚¬â€ Forward Deployed Engineer',
    'Not sure yet',
  ],
  nameLabel: 'Name',
  namePlaceholder: 'Your name',
  emailLabel: 'Email',
  emailPlaceholder: 'you@wherever.com',
  ownedLabel: 'What have you worked on?',
  ownedPlaceholder: 'Products, companies, projects. Whatever you want us to know.',
  linkLabel: 'Link to a CV, portfolio, GitHub or profile',
  /* No attachment: the lead pipeline takes JSON only. Ask for a link. */
  linkPlaceholder: 'https://',
  submit: 'Send application',
  submitting: 'Sending',
  doneTitle: 'Application received.',
  doneBody: 'We read every application. If it is a fit, we reply by email.',
  doneCta: 'Done',
  errors: {
    email: 'Enter an email address we can reply to.',
    owned: 'Tell me what you have worked on.',
    area: 'Pick the closest opening.',
  },
} as const;

export function getLocalizedCareersContent(tI18nComplete: UiTranslator) {
  return localizeUiCatalog(
    { hero, openings, bar, apply, applyForm },
    tI18nComplete,
    MARKETING_SECONDARY_TRANSLATION_KEYS,
  );
}
import { localizeUiCatalog } from '@kortix/ui/i18n';
import { MARKETING_SECONDARY_TRANSLATION_KEYS } from '@/i18n/marketing-secondary-translation-keys.generated';
import type { UiTranslator } from '@/i18n/translator';
