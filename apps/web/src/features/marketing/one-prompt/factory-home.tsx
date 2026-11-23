'use client';

import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { StretchFooter } from './stretch-footer';
import { useGitHubStars } from '@/hooks/use-github-stars';
import { FaqSection } from '@/features/marketing/faq';
import { PricingPlanCard } from '@/features/billing/pricing-plan-card';
import { PRICING_PLANS } from '@/features/billing/pricing-plans';
import { usePricingPlans } from '@/features/billing/use-pricing-plans';
import { DitherField } from '@/features/marketing/kit/dither-field';
import { MarketingButton } from '@/features/marketing/kit/marketing-button';
import { CreditLadder } from '@/features/marketing/pricing/credit-ladder';
import { loopPrompt, REFERENCE_REPOS, setupPromptFor } from '@kortix/shared/setup-guide';
import { cn } from '@kortix/ui';
import { Github } from '@kortix/ui/internal/icons/github';
import { DEFAULT_COMPUTE_SPEC, ENTRY_TIER_USD } from '@kortix/ui/internal/billing/compute-pricing';
import { ArrowRightIcon, ArrowUpRightIcon } from '@phosphor-icons/react';
import Link from 'next/link';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';

import { COMPUTE_HOURLY, FAQ, FREE_COMPUTE_USD, TEAMS } from './factory-content';
import { heroRuns } from './hero-runs';
import { hoopVars, LoopmaxxingWordmark, WORDMARK_VARIANTS, WordmarkVariantContext, type WordmarkVariant } from './hoop';
import { HOOP_PALETTE } from './hoop-palette';
import type { LoopView } from './loops-content';
import { CopyGuideProvider } from './copy-guide';
import { CopyButton, GhostButton, Mark, useForceDarkPage, useSetupTarget } from './parts';
import { EngineGrid } from './engine-grid';
import { HoopScrollbar } from './hoop-scrollbar';
import { PlanFlow } from './plan-flow';
import { AgentTile, ApprovalArt, ComposerArt, ConnectArt, FindArt, ProveArt, SignalArt } from './section-art';
import { SessionReel } from './session-reel';

/** The company site: this page is one product of it. */
const Dosco = 'https://Dosco.com';

/** The column every section sits in: the site grid, the same as the shared FAQ and footer. */
const COLUMN = 'mx-auto w-full max-w-7xl px-6';
/** The space between two sections: each one reads as its own chapter. */
const SECTION = 'py-24 lg:py-32';
const H2 = 'text-foreground text-3xl font-medium tracking-tight text-balance sm:text-4xl lg:text-5xl';
const LEAD = 'text-muted-foreground text-lg text-pretty lg:text-xl';

/** What the one prompt does, in order: the onboarding is the product. */
const STEPS = [
  {
    title: 'Finds your software.',
    body: 'It scans the codebase for every tool you use and asks about the ones it cannot see. Names only, never a secret value.',
    art: <FindArt />,
  },
  { title: 'Connects it.', body: 'Secrets, 3,000+ app connectors, Slack and an environment built from your repo.', art: <ConnectArt /> },
  {
    title: 'Sets the signals.',
    body: 'Issues, merges, errors, messages, signups, schedules. You pick what the agents listen to, all of it in one Dosco.yaml.',
    art: <SignalArt />,
  },
  {
    title: 'Proves it, then stays.',
    body: 'It loops until one real run finishes. Then it adds the Dosco MCP server to your coding agent, so the next loop is one sentence.',
    art: <ProveArt />,
  },
];

/** The page's one action and where to paste it. */
function PromptCta({ prompt, className }: { prompt?: string; className?: string }) {
  return (
    <div className={cn('flex flex-wrap items-center gap-x-5 gap-y-3', className)}>
      <CopyButton text={prompt} icon="shortcut" />
      <span className="text-muted-foreground text-sm">Free to add.</span>
    </div>
  );
}

/** A section's opening: the title, then its lead under it. An action sits on the lead's row, at the right edge. */
function SplitHeading({ title, lead, children }: { title: ReactNode; lead: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex flex-col gap-5">
      <h2 className={cn(H2, 'max-w-3xl')}>{title}</h2>
      <div className="flex flex-col items-start gap-4 sm:flex-row sm:items-end sm:justify-between sm:gap-10">
        <p className={cn(LEAD, 'max-w-3xl')}>{lead}</p>
        {children ? <div className="shrink-0">{children}</div> : null}
      </div>
    </div>
  );
}

/** A cell of a bordered grid: the art on top, faded where the cell crops it, then the words. */
function ArtCell({ art, title, body, className }: { art: ReactNode; title: string; body: string; className?: string }) {
  return (
    <div className={cn('border-border flex min-w-0 flex-col', className)}>
      <div aria-hidden className="flex h-72 items-center justify-center overflow-hidden px-6 [mask-image:linear-gradient(to_bottom,#000_70%,transparent)] sm:h-80 sm:px-10">
        {art}
      </div>
      <div className="flex flex-col gap-2 px-6 pt-2 pb-8 sm:px-8">
        <h3 className="text-foreground text-base font-medium">{title}</h3>
        <p className="text-muted-foreground max-w-md text-base text-pretty">{body}</p>
      </div>
    </div>
  );
}

/**
 * One tall card: the art in the middle, the name and one line at the bottom. Every card keeps an
 * action row, so the titles line up. The light card lights up on hover: a dither rises from its
 * bottom edge at 60%. The dither is a WebGL canvas and a browser keeps only a few alive, so it
 * mounts while a mouse is over the card and unmounts when it leaves.
 */
function TallCard({ art, title, body, action, light }: { art: ReactNode; title: string; body: string; action?: ReactNode; light?: boolean }) {
  const [hovered, setHovered] = useState(false);
  return (
    <div
      onPointerEnter={(event) => light && event.pointerType === 'mouse' && setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      className={cn(
        'relative isolate flex flex-col overflow-hidden rounded-xl border p-6 sm:p-8 lg:min-h-[460px]',
        light ? 'bg-foreground text-background border-transparent' : 'border-border bg-card',
      )}
    >
      {hovered ? (
        <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 opacity-60 [mask-image:linear-gradient(to_top,#000,transparent_75%)]">
          <div className="animate-in fade-in duration-slower absolute inset-0">
            <DitherField className="text-Dosco-base" palette={HOOP_PALETTE} />
          </div>
        </div>
      ) : null}
      <div aria-hidden className="flex flex-1 items-center justify-center py-6 lg:py-10">
        {art}
      </div>
      <div className="flex flex-col gap-2">
        <h3 className={cn('text-base font-medium', light ? 'text-background' : 'text-foreground')}>{title}</h3>
        <p className={cn('text-base text-pretty lg:min-h-18', light ? 'text-background/70' : 'text-muted-foreground')}>{body}</p>
        <div className={cn('h-12 items-end', action ? 'flex' : 'hidden lg:flex')}>{action}</div>
      </div>
    </div>
  );
}

/**
 * Plan lines this page leaves out (founder call 2026-11-18), matched by their
 * English source so a reworded line comes back on its own: top-ups and rate
 * limits are detail for /pricing, and the model controls are on Credits too.
 */
const HIDDEN_FEATURES = new Set([
  'Top up any time. Top-ups never expire',
  'Higher model rate limits',
  'BYOK, ChatGPT subscription, and managed model controls',
]);

/**
 * The plans, as Dosco.com/pricing shows them: the same plan cards, copy and
 * credits ladder, so the two pages never disagree. Free leads with this page's
 * action, the prompt. The band's last row says what credits pay for.
 */
function PlansBand({ prompt }: { prompt: string }) {
  const plans = usePricingPlans().map((plan) => ({
    ...plan,
    features: plan.features.filter((_, index) => !HIDDEN_FEATURES.has(PRICING_PLANS.find((source) => source.id === plan.id)?.features[index] ?? '')),
  }));
  const [monthlyUsd, setMonthlyUsd] = useState<number>(ENTRY_TIER_USD);
  return (
    <div className="border-border mt-16 overflow-hidden rounded-xl border">
      <div className="divide-border grid grid-cols-1 divide-y lg:grid-cols-3 lg:divide-x lg:divide-y-0">
        {plans.map((plan) => (
          <PricingPlanCard
            key={plan.id}
            plan={plan}
            priceSlot={
              plan.id === 'credits' ? (
                <CreditLadder value={monthlyUsd} onChange={setMonthlyUsd} />
              ) : plan.id === 'free' ? (
                <p className="flex items-baseline gap-2">
                  <span className="text-2xl tabular-nums">{plan.price}</span>
                  <span className="text-muted-foreground text-sm">{FREE_COMPUTE_USD} of compute every month</span>
                </p>
              ) : undefined
            }
            // Free and Credits start the same way, by copying the prompt: one Copy prompt under the band covers both.
            // Enterprise keeps its demo request (founder calls 2026-11-18).
            action={
              plan.id === 'enterprise' ? (
                <MarketingButton variant="secondary" size="md" className="hit-area-y-1 w-full" asChild>
                  <a href={`${Dosco}/enterprise`}>Request demo</a>
                </MarketingButton>
              ) : null
            }
          />
        ))}
      </div>
      <div className="border-border flex flex-col items-start justify-between gap-4 border-t px-6 py-6 sm:px-8 md:flex-row md:items-center md:gap-10">
        <p className="text-muted-foreground max-w-3xl text-base text-pretty">
          <span className="text-foreground">Credits pay only for the cloud computer your agents run on.</span> {COMPUTE_HOURLY} an hour for the
          default {DEFAULT_COMPUTE_SPEC} machine, billed per second. Nothing while it is stopped.
        </p>
        {/* The band's one action. The hero's button owns the C key. */}
        <span className="w-full shrink-0 md:w-auto [&>button]:w-full">
          <CopyButton text={prompt} icon="shortcut" bindKey={false} />
        </span>
      </div>
    </div>
  );
}

/** The header's links, in page order. Docs follows them and leaves the page. */
const NAV = [
  { id: 'how', label: 'How it works' },
  { id: 'factories', label: 'Factories' },
  { id: 'pricing', label: 'Pricing' },
] as const;

/** The NAV section in view, under the 64px header: its link reads as current. */
function useSectionInView(): string | null {
  const [active, setActive] = useState<string | null>(null);
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) setActive(entry.target.id);
          else setActive((current) => (current === entry.target.id ? null : current));
        }
      },
      // A section counts once it crosses a line 40% down the view, below the header.
      { rootMargin: '-64px 0px -60% 0px' },
    );
    for (const item of NAV) {
      const section = document.getElementById(item.id);
      if (section) observer.observe(section);
    }
    return () => observer.disconnect();
  }, []);
  return active;
}

/**
 * The repo's GitHub stars, as the site navbar shows them: the mark always, the
 * count once it loads. `stars`, not `formattedStars`, decides: the formatter
 * returns an en dash for a missing count, and a missing count shows nothing.
 * Phones show only the wordmark and Copy prompt: the stars start at `sm`.
 */
function GitHubStars() {
  const { stars, formattedStars, loading } = useGitHubStars();
  const known = stars !== null && !loading;
  return (
    <a
      href="https://github.com/Dosco-ai/CompanyOS"
      target="_blank"
      rel="noopener noreferrer"
      aria-label={known ? `Dosco on GitHub, ${formattedStars} stars` : 'Dosco on GitHub'}
      className="text-muted-foreground hover:text-foreground mr-2 hidden h-8 items-center gap-1.5 text-sm transition-colors sm:inline-flex"
    >
      <Github className="size-4 shrink-0" />
      {known ? <span className="tabular-nums">{formattedStars}</span> : null}
    </a>
  );
}

const noSubscription = () => () => {};

/**
 * `?wordmark=infinity|linked|split` picks the wordmark's "OO" on the whole
 * page, the takeover included. Missing or unknown: infinity, the default.
 */
function useWordmarkVariant(): WordmarkVariant {
  const asked = useSyncExternalStore(noSubscription, () => new URLSearchParams(window.location.search).get('wordmark'), () => null);
  return WORDMARK_VARIANTS.find((variant) => variant === asked) ?? 'infinity';
}

/**
 * Loopmaxxing (loopmaxxing.sh), the developer landing. One job: get a developer
 * to copy the prompt. The hero is the headline, the copy button and a reel of
 * agent sessions, the first of them running that prompt. Each section after it
 * opens with a title beside its lead, then shows the product: what the prompt
 * does, the factory and the loops you describe, the plan it runs on,
 * Dosco.yaml and the questions.
 */
export function FactoryHome({ loops }: { loops: LoopView[] }) {
  // The factory the page leads with: its name is the headline, its prompt is the one to copy.
  const first = loops[0];
  const target = useSetupTarget();
  const prompt = first ? loopPrompt(first, target) : setupPromptFor(target);
  const runs = useMemo(() => heroRuns(first, prompt), [first, prompt]);
  const name = first?.name ?? 'Software Factory';
  const reference = first ? REFERENCE_REPOS[first.id] : undefined;
  useForceDarkPage();
  const active = useSectionInView();
  const variant = useWordmarkVariant();
  return (
    <WordmarkVariantContext.Provider value={variant}>
    <CopyGuideProvider>
            <div id="loopmaxxing-content" style={hoopVars} className="dark bg-background text-foreground relative min-h-screen overflow-x-clip [color-scheme:dark]">
        <HoopScrollbar />
        <header className="bg-background/80 border-border sticky top-0 z-30 border-b backdrop-blur">
          <div className={cn(COLUMN, 'flex h-16 items-center justify-between gap-4')}>
            {/* The logo is one link home: /loopmaxxing on every host (loopmaxxing.sh sends that path to its root). This
                page is home, so a click scrolls it to the top instead of leaving it. */}
            <Link
              href="/loopmaxxing"
              aria-label="Loopmaxxing by Dosco, home"
              onClick={(event) => {
                event.preventDefault();
                window.scrollTo({ top: 0, behavior: 'smooth' });
              }}
              className="group/wordmark text-foreground hit-area-y-3 flex items-center gap-4"
            >
              <span aria-hidden className="inline-flex">
                <KortixLogo size={16} variant="logomark" />
              </span>
              <span aria-hidden className="font-mono text-base font-medium uppercase">
                <LoopmaxxingWordmark tracking="wide" />
              </span>
            </Link>
            <nav className="text-muted-foreground hidden items-center gap-8 text-sm md:flex">
              {NAV.map((item) => (
                <Link
                  key={item.id}
                  href={`#${item.id}`}
                  aria-current={active === item.id ? 'location' : undefined}
                  className={cn('hover:text-foreground transition-colors', active === item.id && 'text-foreground')}
                >
                  {item.label}
                </Link>
              ))}
              <a href={`${Dosco}/docs/developers`} className="hover:text-foreground inline-flex items-center gap-1 transition-colors">
                Docs
                <ArrowUpRightIcon aria-hidden className="size-3" />
              </a>
            </nav>
            <div className="flex items-center gap-2">
              <GitHubStars />
              <span className="hidden sm:contents">
                <GhostButton href={`${Dosco}/auth`}>Sign in</GhostButton>
              </span>
              {/* Shows the C key; the hero's button owns it, so one press copies once. */}
              <CopyButton size="sm" text={prompt} icon="shortcut" bindKey={false} />
            </div>
          </div>
        </header>

        <main>
          <section className="relative">
            <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-48 sm:h-[560px]">
              <DitherField className="text-Dosco-base" palette={HOOP_PALETTE} fade="top-right" />
            </div>
            <div className={cn(COLUMN, 'relative')}>
            {/* Eyebrow, headline, one short intro: the headline carries the page, the intro stays two lines of grey. */}
            <div className="flex flex-col items-start pt-20 pb-14 lg:pt-32 lg:pb-20">
              <span className="text-foreground text-base">For dev teams</span>
              <h1 className="text-foreground mt-4 max-w-4xl text-4xl font-medium tracking-tight text-balance sm:text-5xl lg:text-6xl">
                Add a {name}
                <br />
                with 1 prompt.
              </h1>
              <p className="text-muted-foreground mt-5 max-w-lg text-base text-pretty">
                Agents work on your repo and your tools in the cloud, 24/7, without you prompting them. One prompt sets them up.
              </p>
              <p className="text-muted-foreground mt-3 inline-flex flex-wrap items-center gap-x-1.5 text-sm">
                Integrates with <Mark name="Claude Code" /> <Mark name="Codex" /> and any API key
              </p>
              <PromptCta prompt={prompt} className="mt-8" />
            </div>
            <div className="pb-8">
              <SessionReel runs={runs} />
            </div>
            </div>
          </section>

          <section id="how" className={cn(COLUMN, SECTION, 'scroll-mt-16')}>
            <SplitHeading
              title="One conversation sets up the whole loop"
              lead="The prompt walks your coding agent through the setup with you, and stops when one real run has finished."
            />
            <div className="border-border mt-16 grid grid-cols-[minmax(0,1fr)] overflow-hidden rounded-xl border md:grid-cols-2 [&>*]:border-b [&>*:last-child]:border-b-0 md:[&>*:nth-child(odd)]:border-r md:[&>*:nth-last-child(-n+2)]:border-b-0">
              {STEPS.map((step) => (
                <ArtCell key={step.title} {...step} />
              ))}
            </div>
          </section>

          <section id="factories" className={cn(COLUMN, SECTION, 'scroll-mt-16')}>
            <SplitHeading title={`Start with a factory, then loop anything`} lead={first?.line ?? 'Issues, failing tests and errors in. Verified pull requests out.'}>
              {reference ? (
                <a href={reference} className="text-muted-foreground hover:text-foreground hit-area-y-4 inline-flex items-center gap-1.5 text-sm transition-colors">
                  See the template
                  <ArrowRightIcon className="size-3.5" />
                </a>
              ) : null}
            </SplitHeading>
            <div className="mt-16 grid grid-cols-[minmax(0,1fr)] gap-3 lg:grid-cols-3">
              <TallCard
                light
                art={<ComposerArt tone="light" agent={first?.agent ?? 'engineer'} text="Run the tests. File what fails." />}
                title={name}
                body={`1 agent, ${first?.triggers ?? 3} triggers and ${first?.skills ?? 1} ${first?.skills === 1 ? 'skill' : 'skills'}, from a public template your agent adapts to your repo.`}
                action={<CopyButton text={prompt} icon="shortcut" bindKey={false} />}
              />
              <TallCard
                art={<ComposerArt agent="sales" text="Every new signup: research the company, score it and draft the outreach." />}
                title="Any loop you describe"
                body="Say what should happen and when. Your coding agent writes it as code in your repo."
                action={<CopyButton variant="secondary" text={setupPromptFor(target)} />}
              />
              <TallCard art={<ApprovalArt />} title="You approve what ships" body="Every pull request, post and outbound draft waits for a person until you allow more." />
            </div>
            <ul className="mt-20 grid grid-cols-2 gap-x-6 gap-y-12 lg:grid-cols-3 lg:gap-x-10 lg:gap-y-14">
              {TEAMS.map((team) => (
                <li key={team.slug} className="flex flex-col">
                  <AgentTile slug={team.slug} size={21} />
                  <span className="text-foreground mt-5 text-base font-medium">{team.name}</span>
                  <span className="text-muted-foreground mt-1.5 max-w-72 text-base text-pretty">{team.line}</span>
                </li>
              ))}
            </ul>
          </section>

          <section className={cn(COLUMN, SECTION)}>
            <SplitHeading
              title="Bring the plan you already pay for"
              lead="Connect your Claude or ChatGPT subscription, or any API key."
            />
            <PlanFlow />
          </section>

          <section id="engine" className={cn(COLUMN, SECTION, 'scroll-mt-16')}>
            <SplitHeading
              title="One file in your repo runs all of it"
              lead="The setup adds Dosco.yaml. It defines every agent, what starts it and what it may touch. You review it like code."
            />
            <EngineGrid />
          </section>

          <section id="pricing" className={cn(COLUMN, SECTION, 'scroll-mt-16')}>
            <SplitHeading
              title={`Free to add. ${FREE_COMPUTE_USD} of compute included every month.`}
              lead="Past that you pay only for the cloud computer your agents run on. Models run on your own Claude or Codex subscription or API key."
            />
            <PlansBand prompt={prompt} />
          </section>

          <FaqSection
            eyebrow="Frequently asked questions"
            title="The questions developers ask before they paste the prompt."
            items={FAQ.map((item, index) => ({ id: `loopmaxxing-faq-${index + 1}`, question: item.q, answer: item.a }))}
          />
        </main>

        <StretchFooter prompt={prompt} />
      </div>
    </CopyGuideProvider>
    </WordmarkVariantContext.Provider>
  );
}
