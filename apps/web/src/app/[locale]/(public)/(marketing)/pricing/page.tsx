'use client';

import Link from '@/components/site-link';
import type { PricingPlan, PricingPlanId } from '@/features/billing/pricing-plans';
import { usePricingPlans } from '@/features/billing/use-pricing-plans';
import { CompareTable } from '@/features/marketing/pricing/compare-table';
import { useRequestDemo } from '@/features/contact/request-demo-provider';
import { useEnglishOnly } from '@/features/marketing/kit/english-only';
import { MarketingButton } from '@/features/marketing/kit/marketing-button';
import { Band, PageFrame } from '@/features/marketing/kit/page-frame';
import { WorksWithStrip } from '@/features/marketing/landing-sections/works-with-strip';
import { CreditLadder } from '@/features/marketing/pricing/credit-ladder';
import { useLocale, useTranslations } from '@/i18n/use-translations';
import { safeJsonForHtml } from '@/lib/security/safe-json';
import { cn } from '@kortix/ui';
import { useLocalizedUiCatalog } from '@kortix/ui/i18n';
import {
  agentHoursForCredits,
  COMPUTE_RATES_USD,
  DEFAULT_COMPUTE_CREDITS_PER_HOUR,
  DEFAULT_COMPUTE_SPEC,
  DEFAULT_TIER_USD,
  formatWholeUsd,
  FREE_MONTHLY_CREDITS,
  MINUTES_PER_CREDIT,
  monthlyCreditsForUsd,
  PLATFORM_FEE_PERCENT,
  TOP_UP_BONUS_STEPS,
} from '@kortix/ui/internal/billing/compute-pricing';
import { SolidCheckIcon } from '@kortix/ui/internal/icons/solid-check-icon';
import { PlusIcon } from '@phosphor-icons/react';
import { Fragment, useState, type ReactNode } from 'react';

const START_URL = '/auth';

// Keyed by MARKETING plan id (display-only — see pricing-plans.ts). Never an
// API tier key.
const PLAN_CTAS: Record<PricingPlanId, { cta: string; href: string }> = {
  free: { cta: 'Get started', href: START_URL },
  credits: { cta: 'Get started', href: START_URL },
  enterprise: { cta: 'Request demo', href: '/enterprise' },
};

/** The FAQ ids, in display order. Question and answer live in `billing.pricing.faq.<id>`. */
const FAQ_IDS = [
  'free',
  'credit',
  'amounts',
  'members',
  'rollover',
  'models',
  'topup',
  'change',
  'existing',
  'enterprise',
] as const;

/** The compute rate card rows, in display order. */
const RATE_ROWS = [
  { id: 'vcpu', usd: COMPUTE_RATES_USD.vcpuHour },
  { id: 'memory', usd: COMPUTE_RATES_USD.memoryGbHour },
  { id: 'disk', usd: COMPUTE_RATES_USD.diskGbMonth },
] as const;

/** "Models are separate": the three ways a model call is paid, in display order. */
const MODEL_SOURCES = ['keys', 'chatgpt', 'kortix'] as const;

/** `$0.0324` — a rate in USD with up to four decimals. */
function formatRateUsd(amount: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(amount);
}

/** A catalog sentence with no full stop gets one, so both title lines end alike. */
function sentence(text: string): string {
  return /[.!?。！？]$/.test(text) ? text : `${text}.`;
}

/** The landing section heading: the two-tone title and an optional line under it, inside the text gutter. */
function BandHeading({
  title,
  titleMuted,
  description,
  id,
}: {
  title: ReactNode;
  titleMuted?: ReactNode;
  description?: ReactNode;
  id?: string;
}) {
  return (
    <div className="px-8 pb-12 lg:px-28">
      <h2
        id={id}
        className="text-foreground text-xl font-medium tracking-tight text-balance md:text-2xl lg:text-3xl"
      >
        {title}
        {titleMuted ? (
          <>
            {' '}
            <span className="text-muted-foreground block">{titleMuted}</span>
          </>
        ) : null}
      </h2>
      {description ? (
        <p className="text-muted-foreground mt-4 max-w-xl text-base text-pretty">{description}</p>
      ) : null}
    </div>
  );
}

/** One plan column (Accrue): name and note, price, action, a dashed rule, then what it includes. */
function PlanColumn({ plan, includedLabel }: { plan: PricingPlan; includedLabel: string }) {
  const { cta, href } = useLocalizedUiCatalog(PLAN_CTAS)[plan.id];
  const openDemo = useRequestDemo();
  const [monthlyUsd, setMonthlyUsd] = useState<number>(DEFAULT_TIER_USD);

  return (
    // From lg the column is a subgrid of the plans band (seven rows: name, note,
    // price, action, rule, label, list), so every row lines up across the three
    // plans even when the credits ladder is taller than a plain price.
    // `grid-cols-1` is minmax(0, 1fr): the one column never grows past the
    // padding to fit its content.
    <div
      className={cn(
        'flex flex-col px-4 py-10 lg:row-span-7 lg:grid lg:grid-cols-1 lg:grid-rows-subgrid lg:px-8 lg:py-12',
        plan.highlight && 'bg-card',
      )}
    >
      {/* h2: the plans sit directly under the page h1. */}
      <h2 className="text-foreground text-lg font-medium tracking-tight">{plan.name}</h2>
      <p className="text-muted-foreground mt-1 text-sm text-pretty">{plan.note}</p>
      <div className="mt-10">
        {plan.id === 'credits' ? (
          <CreditLadder value={monthlyUsd} onChange={setMonthlyUsd} />
        ) : (
          <p className="flex items-baseline gap-2">
            <span className="text-2xl tabular-nums">{plan.price}</span>
            {plan.unit ? <span className="text-muted-foreground text-sm">{plan.unit}</span> : null}
          </p>
        )}
      </div>
      {plan.id === 'enterprise' ? (
        <MarketingButton
          size="md"
          variant="secondary"
          className="hit-area-y-1 mt-6 w-full"
          onClick={() => openDemo({ source: 'pricing-enterprise' })}
        >
          {cta}
        </MarketingButton>
      ) : (
        <MarketingButton
          size="md"
          variant={plan.highlight ? 'primary' : 'secondary'}
          className="hit-area-y-1 mt-6 w-full"
          asChild
        >
          <Link href={href}>{cta}</Link>
        </MarketingButton>
      )}
      <div aria-hidden className="mt-10 border-t border-dashed" />
      <p className="text-muted-foreground mt-8 text-sm">{includedLabel}</p>
      <ul className="text-foreground mt-4 flex flex-col gap-3.5 text-sm">
        {plan.features.map((feature) => (
          <li key={feature} className="flex items-start gap-3">
            <SolidCheckIcon className="text-ring mt-0.5" />
            <span className="text-pretty">{feature}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Compare plans (Accrue): the two-tone heading, then the table in a band. */
function ComparePlans({ plans, locale }: { plans: PricingPlan[]; locale: string }) {
  return (
    <section id="compare" className="scroll-mt-16 pt-24 lg:pt-32">
      <BandHeading title="Compare plans." titleMuted="Every plan runs the same product." />
      <Band>
        <CompareTable plans={plans} locale={locale} />
      </Band>
    </section>
  );
}

/**
 * /pricing, in the landing page's border layout (after Accrue's pricing page):
 * one 1440px column between two hairline rails. Each block is a two-tone
 * heading in the text gutter, then a band whose hairlines cross the page.
 * Order: plans, works-with strip, compare table, agent hours, models, FAQ.
 * The closing call to action and the footer come from the marketing shell.
 */
export default function PricingPage() {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const t = useTranslations('billing.pricing');
  const locale = useLocale();
  const plans = usePricingPlans();
  const englishOnly = useEnglishOnly();

  // Every number on this page comes from compute-pricing.ts, so the page
  // cannot drift from the billing code.
  const tierCredits = monthlyCreditsForUsd(DEFAULT_TIER_USD);
  const bonusSmallest = TOP_UP_BONUS_STEPS[TOP_UP_BONUS_STEPS.length - 1];
  const bonusLargest = TOP_UP_BONUS_STEPS[0];
  const facts = {
    freeCredits: new Intl.NumberFormat(locale).format(FREE_MONTHLY_CREDITS),
    creditsPerHour: DEFAULT_COMPUTE_CREDITS_PER_HOUR,
    minutes: MINUTES_PER_CREDIT,
    spec: DEFAULT_COMPUTE_SPEC,
    fee: PLATFORM_FEE_PERCENT,
    tierUsd: formatWholeUsd(DEFAULT_TIER_USD, locale),
    hours: new Intl.NumberFormat(locale).format(agentHoursForCredits(tierCredits)),
    smallestBonus: bonusSmallest.percent,
    smallestBonusUsd: formatWholeUsd(bonusSmallest.minUsd, locale),
    largestBonus: bonusLargest.percent,
    largestBonusUsd: formatWholeUsd(bonusLargest.minUsd, locale),
    vcpuRate: formatRateUsd(COMPUTE_RATES_USD.vcpuHour, locale),
    memoryRate: formatRateUsd(COMPUTE_RATES_USD.memoryGbHour, locale),
    diskRate: formatRateUsd(COMPUTE_RATES_USD.diskGbMonth, locale),
  };
  const faq = FAQ_IDS.map((id) => ({
    id,
    question: t(`faq.${id}.question`),
    answer: t(`faq.${id}.answer`, facts),
  }));

  return (
    <PageFrame>
      {/* ── Hero and plans: the free offer first, as the reader's first question ── */}
      <section id="plans" className="relative">
        <div className="flex flex-col gap-7.5 px-8 pt-40 pb-16 lg:px-28 lg:pt-48 lg:pb-20">
          {/* English only for now: the catalog's hero title and button are retired. */}
          <h1 className="text-foreground max-w-261 text-3xl font-medium tracking-tight text-balance sm:text-4xl lg:text-5xl lg:leading-14">
            Put agents to work across your company.
            <span className="text-muted-foreground block">
              Your first agent runs in minutes. You pay for the work, not per seat.
            </span>
          </h1>
        </div>

        <Band className="divide-border grid grid-cols-1 divide-y lg:grid-cols-3 lg:divide-x lg:divide-y-0">
          {plans.map((plan) => (
            <PlanColumn
              key={plan.id}
              plan={plan}
              includedLabel={englishOnly('What’s included') ?? plan.name}
            />
          ))}
        </Band>
      </section>

      {/* ── Works with: the landing logo strip, flush under the plans. The
          plans band's bottom hairline is the strip's top edge. ── */}
      <WorksWithStrip />

      {/* ── Compare plans: English only until the rows have catalog keys ── */}
      {locale === 'en' ? <ComparePlans plans={plans} locale={locale} /> : null}

      {/* ── Agent hours: what one credit buys ── */}
      <section id="agent-hours" className="scroll-mt-16 pt-24 lg:pt-32">
        <BandHeading
          title={sentence(t('hours.title', facts))}
          titleMuted={sentence(t('hours.rate.value', facts))}
          description={t('hours.description', facts)}
        />
        <Band className="grid grid-cols-1 lg:grid-cols-12">
          <dl className="divide-border grid grid-cols-1 divide-y sm:grid-cols-2 sm:divide-x sm:divide-y-0 lg:col-span-7">
            {(['hour', 'tier'] as const).map((id) => (
              <div key={id} className="flex flex-col px-4 py-10 lg:px-11 lg:py-12">
                <dt className="text-muted-foreground order-last mt-3 text-sm text-pretty">
                  {t(`hours.${id}.note`, facts)}
                </dt>
                <dd className="text-foreground text-2xl font-medium tracking-tight tabular-nums md:text-3xl">
                  {t(`hours.${id}.value`, facts)}
                </dd>
              </div>
            ))}
          </dl>
          <div className="bg-card border-t px-4 py-10 lg:col-span-5 lg:border-t-0 lg:border-l lg:px-11 lg:py-12">
            <h3 className="text-foreground text-base font-medium">{t('hours.rates.title')}</h3>
            <p className="text-muted-foreground mt-2 text-sm text-pretty">
              {t('hours.rates.note')}
            </p>
            <dl className="divide-border mt-6 flex flex-col divide-y border-y">
              {RATE_ROWS.map(({ id, usd }) => (
                <div key={id} className="flex items-baseline justify-between gap-4 py-3.5 text-sm">
                  <dt className="text-muted-foreground">{t(`hours.rates.${id}.label`)}</dt>
                  <dd className="text-foreground tabular-nums">
                    {t(`hours.rates.${id}.price`, { price: formatRateUsd(usd, locale) })}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        </Band>
      </section>

      {/* ── Models are separate: three sources, one column each ── */}
      <section id="models" className="scroll-mt-16 pt-24 lg:pt-32">
        <BandHeading
          title={sentence(t('models.title'))}
          titleMuted={englishOnly('You choose where each call goes.')}
          description={t('models.description')}
        />
        <Band>
          <ul className="divide-border grid grid-cols-1 divide-y lg:grid-cols-3 lg:divide-x lg:divide-y-0">
            {MODEL_SOURCES.map((id) => (
              <li key={id} className="flex flex-col px-4 py-10 lg:px-11 lg:py-12">
                <p className="text-muted-foreground text-sm">{t(`models.${id}.tag`)}</p>
                <h3 className="text-foreground mt-6 text-lg font-medium tracking-tight text-balance">
                  {t(`models.${id}.title`)}
                </h3>
                <p className="text-muted-foreground mt-2 text-sm text-pretty">
                  {t(`models.${id}.body`, facts)}
                </p>
              </li>
            ))}
          </ul>
          <div className="bg-card flex flex-col items-start justify-between gap-6 border-t px-4 py-8 lg:flex-row lg:items-center lg:px-11">
            <p className="text-foreground max-w-2xl text-base font-medium text-balance">
              {t('models.summary')}
            </p>
            <MarketingButton size="md" className="hit-area-y-1" asChild>
              <Link href={START_URL}>{t('hero.cta')}</Link>
            </MarketingButton>
          </div>
        </Band>
      </section>

      {/* ── FAQ: the landing FAQ's shape, heading left, questions right ── */}
      <section id="faq" className="scroll-mt-16 px-8 py-24 lg:px-28 lg:py-32">
        <div className="grid grid-cols-1 gap-y-12 lg:grid-cols-3">
          <div className="lg:pr-8">
            <h2 className="text-foreground text-xl font-medium tracking-tight text-balance md:text-2xl lg:text-3xl">
              {sentence(
                tI18nHardcoded.raw(
                  'autoAppPublicMarketingPricingPageJsxTextPricingQuestionsa7129c6e',
                ),
              )}
              {englishOnly('Anything else, talk to us.') ? (
                <>
                  {' '}
                  <span className="text-muted-foreground block">
                    {englishOnly('Anything else, talk to us.')}
                  </span>
                </>
              ) : null}
            </h2>
            <MarketingButton size="md" variant="secondary" className="hit-area-y-1 mt-8" asChild>
              <Link href="/contact">
                {tI18nHardcoded.raw('appHomeTutorialsPage.line329JsxTextContactUs')}
              </Link>
            </MarketingButton>
          </div>

          {/* The answers start collapsed; this states every one for search and answer engines. */}
          <script
            type="application/ld+json"
            dangerouslySetInnerHTML={{
              __html: safeJsonForHtml({
                '@context': 'https://schema.org',
                '@type': 'FAQPage',
                mainEntity: faq.map((item) => ({
                  '@type': 'Question',
                  name: item.question,
                  acceptedAnswer: { '@type': 'Answer', text: item.answer },
                })),
              }),
            }}
          />

          <div className="divide-border flex flex-col divide-y lg:col-span-2">
            {faq.map((item) => (
              <details
                key={item.id}
                id={item.id}
                className="group scroll-mt-16 py-6 first:pt-0 last:pb-0"
              >
                <summary className="text-foreground outline-ring flex w-full cursor-pointer list-none items-start justify-between rounded-sm text-left text-lg select-none focus-visible:outline-2 focus-visible:outline-offset-4 [&::-webkit-details-marker]:hidden">
                  <span className="pr-8 text-pretty">{item.question}</span>
                  <PlusIcon
                    aria-hidden
                    className="group-open:text-muted-foreground duration-normal mt-1.5 size-4 shrink-0 transition-[rotate,color] ease-out group-open:-rotate-45 motion-reduce:transition-none"
                  />
                </summary>
                <p className="text-muted-foreground max-w-2xl py-4 text-base text-pretty">
                  {item.answer}
                </p>
              </details>
            ))}
          </div>
        </div>
      </section>
    </PageFrame>
  );
}
