// The credit ledger is rendered in two places — account settings (Usage →
// Credit ledger) and the admin account sheet — from two different endpoints.
// One presentational feed serves both, so the operator view cannot drift from
// what the customer sees. These tests pin the shared piece and the fact that
// both callers actually use it.
import { describe, expect, test } from 'bun:test';
import { NextIntlClientProvider, createTranslator } from 'next-intl';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { localizeUiCatalog } from '@kortix/ui/i18n';
import { APP_REGISTRY_TRANSLATION_KEYS } from '@kortix/ui/i18n/ui-catalog/app-registry-translation-keys.generated';
import { TooltipProvider } from '@kortix/ui/tooltip';
import { CreditActivityFeed, formatEntryTime } from './credit-activity-feed';
import {
  TRANSACTION_BADGES,
  creditTransactionBadge,
  type CreditTransactionRow,
} from './transactions-table';
import en from '../../../translations/en.json';
import zh from '../../../translations/zh.json';

const dir = import.meta.dir;
const creditTransactionsSource = readFileSync(join(dir, 'credit-transactions.tsx'), 'utf8');
const adminPageSource = readFileSync(
  join(dir, '../../app/[locale]/admin/accounts/page.tsx'),
  'utf8',
);

describe('creditTransactionBadge', () => {
  test('names the ledger types an operator reads most', () => {
    expect(creditTransactionBadge('admin_grant').label).toBe('Admin Grant');
    expect(creditTransactionBadge('compute_debit').label).toBe('Sandbox');
    expect(creditTransactionBadge('token_deduction').label).toBe('LLM');
    expect(creditTransactionBadge('expired').variant).toBe('destructive');
  });

  test('an unknown type renders as itself instead of disappearing', () => {
    // New ledger types ship from the API before the UI knows them; showing the
    // raw key beats showing nothing.
    expect(creditTransactionBadge('some_new_type')).toEqual({
      label: 'some_new_type',
      variant: 'outline',
    });
  });

  test('every ledger badge label carries a catalog key every locale can resolve', () => {
    // `localizeUiCatalog` translates a label only when the generated key map
    // names it and the locale catalog holds that key; a label without a key
    // renders in English for every non-English locale (the v0.15.4 gate
    // failure: five ledger labels had no catalog entries).
    const english = en.hardcodedUi.i18nComplete as Record<string, string>;
    const labels = new Set(Object.values(TRANSACTION_BADGES).map((badge) => badge.label));
    for (const label of labels) {
      const key = APP_REGISTRY_TRANSLATION_KEYS[label];
      expect(key, label).toMatch(/^text[0-9a-f]{12}$/);
      expect(english[key], `en:${label}`).toBe(label);
    }

    // The key sets are pinned in parity across locales by
    // src/i18n/i18n-complete.test.tsx; spot-check the real runtime path: the
    // zh catalog translates a label that used to fall through to English.
    const tZh = createTranslator({
      locale: 'zh',
      messages: zh,
      namespace: 'hardcodedUi.i18nComplete',
    });
    expect(
      localizeUiCatalog(TRANSACTION_BADGES, tZh, APP_REGISTRY_TRANSLATION_KEYS).topup_bonus.label,
    ).toBe('充值奖励');
  });
});

describe('the shared ledger feed is the only implementation', () => {
  test('the customer credit ledger renders through it', () => {
    expect(creditTransactionsSource).toContain('CreditActivityFeed');
    // The caller must not keep a second copy of the row markup.
    expect(creditTransactionsSource).not.toContain('<TableHeader>');
  });

  test('the admin sheet renders the same feed, not a hand-rolled list', () => {
    expect(adminPageSource).toContain('CreditActivityFeed');
    expect(adminPageSource).toContain('adminLedgerRows');
  });

  test('a row carries everything both endpoints can supply', () => {
    const row: CreditTransactionRow = {
      id: 'led_1',
      createdAt: '2026-08-11T10:00:00.000Z',
      type: 'admin_grant',
      description: 'goodwill',
      isExpiring: true,
      amount: 25,
      balanceAfter: 27.5,
    };
    expect(row.amount).toBe(25);
    // `isExpiring` is optional: an endpoint that does not report it leaves the
    // Credit type cell empty rather than claiming "Permanent".
    const partial: CreditTransactionRow = {
      id: 'led_2',
      createdAt: null,
      type: 'usage',
      description: null,
      amount: -1,
      balanceAfter: 26.5,
    };
    expect(partial.isExpiring).toBeUndefined();
  });
});

/** The translated labels need the provider; nothing here asserts on them. */
const render = (rows: CreditTransactionRow[]) =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={{}} onError={() => {}}>
      <TooltipProvider>
        <CreditActivityFeed rows={rows} />
      </TooltipProvider>
    </NextIntlClientProvider>,
  );

describe('CreditActivityFeed renders a ledger row', () => {
  const grant: CreditTransactionRow = {
    id: 'led_1',
    createdAt: '2026-08-11T10:00:00.000Z',
    type: 'admin_grant',
    description: 'goodwill',
    isExpiring: true,
    amount: 25,
    balanceAfter: 27.5,
  };

  test('a credit is labelled, signed, in ink, with a green tile and the balance after', () => {
    const html = render([grant]);
    expect(html).toContain('Admin Grant');
    expect(html).toContain('goodwill');
    expect(html).toContain('+2,500');
    expect(html).toContain('2,750');
    expect(html).toContain('bg-kortix-green/15');
    // The figure itself is ink: a credit is not "good", a debit is not an error.
    expect(html).not.toMatch(/text-kortix-(green|red)[^"]*">\+2,500/);
  });

  test('a debit keeps its minus sign, in ink, under its cost-type tile', () => {
    const html = render([{ ...grant, id: 'led_2', type: 'compute_debit', amount: -1.25 }]);
    expect(html).toContain('Sandbox');
    expect(html).toContain('-125');
    expect(html).toContain('bg-kortix-blue/15');
    expect(html).not.toContain('text-kortix-red');
  });

  test('a generic usage row takes the colour of what it charged for', () => {
    const html = render([
      { ...grant, id: 'led_4', type: 'usage', description: 'Sandbox compute · 1vCPU · 139s', amount: -0.04 },
      { ...grant, id: 'led_5', type: 'usage', description: 'deepseek-v4.1-flash', amount: -0.5 },
    ]);
    expect(html).toContain('bg-kortix-blue/15');
    expect(html).toContain('bg-kortix-orange/15');
  });

  test('raw ids in a description are cut to eight characters', () => {
    const html = render([
      {
        ...grant,
        id: 'led_6',
        type: 'usage',
        description: 'Sandbox compute · 276956e5-b9d4-48e9-be62-c0a389b9f183 · 2s',
      },
    ]);
    expect(html).toContain('Sandbox compute · 276956e5 · 2s');
    expect(html).not.toContain('c0a389b9f183');
  });

  test('a row with no description or credit type still renders', () => {
    const html = render([
      {
        id: 'led_3',
        createdAt: null,
        type: 'usage',
        description: null,
        amount: 0,
        balanceAfter: 0,
      },
    ]);
    expect(html).toContain('No description');
    expect(html).not.toContain('Permanent');
    expect(html).not.toContain('Expiring');
  });

  test('both figures are named: one header for the eye, a label per row for a screen reader', () => {
    const html = render([grant]);
    expect(html).toContain('>Credits</span>');
    expect(html).toContain('>Credits After</span>');
    expect(html).toContain('<span class="sr-only">Credits </span>');
    expect(html).toContain('<span class="sr-only">Credits After </span>');
  });

  test('a tiny debit reads <0.01 with no sign', () => {
    expect(render([{ ...grant, id: 'led_7', type: 'usage', amount: -0.00001 }])).toContain('>&lt;0.01<');
    expect(render([{ ...grant, id: 'led_8', type: 'refund', amount: 0.00001 }])).toContain('>+&lt;0.01<');
  });

  test('an empty ledger renders an empty list', () => {
    const html = render([]);
    expect(html).not.toContain('<li');
  });
});

test('expiring grants show their recorded lapse date', () => {
  const html = render([
    {
      id: 'expiry',
      createdAt: null,
      type: 'tier_grant',
      description: null,
      isExpiring: true,
      expiresAt: '2026-11-24T12:00:00Z',
      amount: 5,
      balanceAfter: 5,
    },
  ]);
  expect(html).toContain('Expiring Nov 24, 2026');
});

describe('formatEntryTime', () => {
  const date = new Date('2025-12-30T10:00:00Z');
  test('leaves the year out for this year and keeps it for any other', () => {
    expect(formatEntryTime(date, 2025, 'en-US')).not.toContain('2025');
    expect(formatEntryTime(date, 2026, 'en-US')).toContain('2025');
  });
});
