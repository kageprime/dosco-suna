'use client';

import { cn } from '@kortix/ui';
import { Button } from '@kortix/ui/button';
import { KortixLogo } from '@/components/sidebar/kortix-logo';
import Link from 'next/link';

import { YamlLine } from '@/features/marketing/code-panel';
import { DitherField } from '@/features/marketing/kit/dither-field';
import { DitherRidge } from '@/features/marketing/kit/dither-ridge';
import { ENGINE, MANIFEST } from '@/features/marketing/one-prompt/factory-content';
import type { LoopView } from '@/features/marketing/one-prompt/loops-content';
import { Eyebrow, GhostButton, Mark } from '@/features/marketing/one-prompt/parts';

import { RoleCards } from './role-cards';
import { SessionCarousel } from './session-carousel';

/** The column every section sits in. */
const COLUMN = 'mx-auto w-full max-w-7xl px-6';
const H2 = 'text-foreground max-w-3xl text-3xl font-medium tracking-tight text-balance sm:text-4xl lg:text-5xl';
const BODY = 'text-muted-foreground max-w-xl text-base text-pretty';

const STEPS = [
  {
    title: 'Connect a repository.',
    body: 'The repository becomes your workspace. Agents, skills, connectors and memory live in one place you own.',
  },
  {
    title: 'Choose the roles.',
    body: 'Start with engineering, marketing, sales, support and recruiting. Each agent has its own job and its own cloud computer.',
  },
  {
    title: 'Set the signals.',
    body: 'An issue, a merge, a signup, a ticket or a schedule. You decide what each role watches and when it acts.',
  },
  {
    title: 'Approve the work.',
    body: 'An agent returns a change request with the finished work. Nothing merges itself unless you grant that capability.',
  },
];

const FAQ = [
  {
    q: 'Do I need to hire a team first?',
    a: 'No. Start with the roles the templates ship. Each one has a defined job, a cloud computer and a path back to your repository for approval.',
  },
  {
    q: 'What does a person still need to do?',
    a: 'Set direction, connect the tools and approve change requests. You decide what ships.',
  },
  {
    q: 'Which models do the agents use?',
    a: 'The plan you already pay for: your Claude or ChatGPT subscription, or any API key you add. Scheduled runs use it too.',
  },
  {
    q: 'Can an agent merge its own work?',
    a: 'No. Session work reaches main through a change request, and merge is default-deny for agents.',
  },
  {
    q: 'Can agents use the tools my company already has?',
    a: '3,000+ apps in a click, plus MCP, OpenAPI, Postman, GraphQL and raw HTTP. Connector credentials are brokered server-side and never enter the machine.',
  },
  {
    q: 'How do I stop a role?',
    a: 'Pause its triggers with one command, or remove its folder under .kortix/.',
  },
];

const proof = (roles: LoopView[]) => [
  { value: String(roles.length).padStart(2, '0'), label: 'ready roles' },
  { value: '01', label: 'kortix.yaml' },
  { value: '3,000+', label: 'app connectors' },
  { value: '24/7', label: 'cloud work' },
];

/** The one action of the page: an account. */
function SignUp({ children = 'Create your account', size = 'lg' }: { children?: string; size?: 'default' | 'lg' }) {
  return (
    <Button asChild variant="brand" size={size}>
      <Link href="/auth">{children}</Link>
    </Button>
  );
}

/**
 * The Dosco landing. One person leads; capable agents hold the roles. The
 * roles, the counts and the YAML on this page come from the build's real
 * starter templates, so the page shows what the product actually ships.
 *
 * The fold and the footer follow loopmaxxing.sh: a left-aligned headline over a
 * dithered sky, the agent runs as one moving strip, and a dithered ridge the
 * page scrolls over at the end. The type is Roobert (see the route layout).
 */
export function CeoHome({ roles, catalog }: { roles: LoopView[]; catalog: string[] }) {
  return (
    <div className="dark bg-background text-foreground relative min-h-screen overflow-x-clip">
      <header className="border-border bg-background/80 sticky top-0 z-30 border-b backdrop-blur">
        <div className={cn(COLUMN, 'flex h-16 items-center justify-between')}>
          <div className="flex items-center gap-4">
            <Link href="/" aria-label="Dosco" className="text-foreground">
              <KortixLogo size={16} variant="logomark" />
            </Link>
            <span className="text-foreground hidden font-mono text-sm font-medium tracking-wider uppercase sm:inline">
              CompanyOS
            </span>
          </div>
          <nav className="text-muted-foreground hidden items-center gap-8 text-sm md:flex">
            <Link href="#roles" className="hover:text-foreground">
              Roles
            </Link>
            <Link href="#how" className="hover:text-foreground">
              How it works
            </Link>
            <Link href="/pricing" className="hover:text-foreground">
              Pricing
            </Link>
            <Link href="/docs/developers" className="hover:text-foreground">
              Docs
            </Link>
          </nav>
          <div className="flex items-center gap-2">
            <GhostButton href="/auth">Sign in</GhostButton>
            <SignUp size="default">Sign up</SignUp>
          </div>
        </div>
      </header>

      <main>
        {/* The fold: a dithered sky at the top edge, the headline left, the runs below. */}
        <section className="border-border relative overflow-hidden border-b">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-0 h-64 [mask-image:linear-gradient(to_bottom,#000,transparent)] sm:h-[520px]"
          >
            <DitherField className="text-kortix-base -scale-y-100" />
          </div>
          <div className={cn(COLUMN, 'relative')}>
            <div className="flex flex-col items-start pt-20 pb-14 lg:pt-32 lg:pb-20">
              <span className="text-foreground text-base">For founders and CEOs</span>
              <h1 className="text-foreground mt-4 max-w-4xl text-4xl leading-tight font-medium tracking-tight text-balance sm:text-5xl lg:text-6xl">
                Become the CEO.
                <br />
                <span className="text-muted-foreground">Your company runs on agents.</span>
              </h1>
              <p className="text-muted-foreground mt-5 max-w-lg text-base text-pretty">
                Start with capable agents in the roles every company needs. They work in the cloud around the clock and
                return finished work for your approval. You set the direction.
              </p>
              <p className="text-muted-foreground mt-3 text-sm">
                Bring the plan you already pay for: <Mark name="Claude" /> or <Mark name="Codex" />, or any API key.
              </p>
              <div className="mt-8 flex flex-wrap items-center gap-x-5 gap-y-3">
                <SignUp />
                <Link href="#roles" className="text-foreground text-sm underline-offset-4 hover:underline">
                  See the roles
                </Link>
              </div>
              <p className="text-muted-foreground mt-3 text-sm">Free to start.</p>
            </div>
          </div>
          <div className="relative pb-10">
            <SessionCarousel roles={roles} />
          </div>
        </section>

        {/* Proof strip: four verifiable facts, no adjectives. */}
        <section aria-label="At a glance" className={cn(COLUMN, 'py-14')}>
          <dl className="grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
            {proof(roles).map((item) => (
              <div key={item.label} className="flex flex-col gap-1">
                <dt className="text-kortix-base font-mono text-xl">{item.value}</dt>
                <dd className="text-muted-foreground text-sm">{item.label}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section id="roles" className="border-border scroll-mt-16 border-t">
          <div className={cn(COLUMN, 'flex flex-col gap-3 pt-20 pb-12 lg:pt-28')}>
            <Eyebrow>The first team</Eyebrow>
            <h2 className={H2}>Every role your company needs, ready from day one.</h2>
            <p className={BODY}>
              Each role ships as a template with its own agent, triggers and skills. Point the setup at your repository
              and it configures the role with you.
            </p>
          </div>
          <div className="pb-24 lg:pb-32">
            <RoleCards roles={roles} more={catalog} />
          </div>
        </section>

        <section id="how" className="border-border scroll-mt-16 border-t">
          <div className={cn(COLUMN, 'pt-20 pb-12 lg:pt-28')}>
            <Eyebrow>How it works</Eyebrow>
            <h2 className={H2}>From one account to an operating company.</h2>
          </div>
          <ol className={cn(COLUMN, 'grid gap-10 pb-24 sm:grid-cols-2 lg:grid-cols-4 lg:pb-32')}>
            {STEPS.map((step, index) => (
              <li key={step.title} className="flex flex-col gap-3">
                <span className="text-kortix-base font-mono text-xs">{String(index + 1).padStart(2, '0')}</span>
                <span className="text-foreground text-base font-medium">{step.title}</span>
                <span className="text-muted-foreground text-sm text-pretty">{step.body}</span>
              </li>
            ))}
          </ol>
        </section>

        <section id="engine" className="border-border scroll-mt-16 border-t">
          <div className={cn(COLUMN, 'pt-20 pb-12 lg:pt-28')}>
            <Eyebrow>Under the hood</Eyebrow>
            <h2 className={H2}>One file defines the company.</h2>
            <p className={BODY}>
              kortix.yaml names every agent, what starts it and what it may touch. You review it the same way you
              review code.
            </p>
          </div>
          <div className={cn(COLUMN, 'grid gap-10 pb-24 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)] lg:pb-32')}>
            <div className="border-border bg-card overflow-hidden rounded-lg border">
              <div className="border-border text-muted-foreground border-b px-4 py-2.5 font-mono text-xs">
                kortix.yaml
              </div>
              <pre className="overflow-x-auto px-5 py-5 font-mono text-xs leading-6">
                {MANIFEST.map((line, i) => (
                  <span key={i} className="block whitespace-pre">
                    {line === '' ? ' ' : <YamlLine line={line} />}
                  </span>
                ))}
              </pre>
            </div>
            <dl className="grid content-start gap-x-8 gap-y-7 sm:grid-cols-2">
              {ENGINE.map((part) => (
                <div key={part.term} className="flex flex-col gap-2">
                  <dt className="text-foreground flex flex-wrap items-baseline gap-x-3 text-base font-medium">
                    {part.term}
                    <span className="text-kortix-base font-mono text-xs font-normal">{part.key}</span>
                  </dt>
                  <dd className="text-muted-foreground text-sm text-pretty">{part.body}</dd>
                </div>
              ))}
            </dl>
          </div>
        </section>

        <section className="border-border border-t">
          <div className={cn(COLUMN, 'grid gap-10 py-24 lg:grid-cols-[35%_minmax(0,1fr)] lg:gap-x-12 lg:py-32')}>
            <div className="flex flex-col gap-4">
              <h2 className="text-foreground max-w-2xl text-2xl font-medium tracking-tight text-balance sm:text-3xl">
                Questions.
              </h2>
              <p className="text-muted-foreground text-sm">
                <Link href="/contact" className="text-foreground underline underline-offset-4">
                  Talk to the team
                </Link>
              </p>
            </div>
            <div>
              {FAQ.map((item) => (
                <details key={item.q} className="border-border group border-b last:border-b-0">
                  <summary className="text-foreground flex cursor-pointer list-none items-center justify-between gap-6 py-4 text-sm font-medium">
                    {item.q}
                    <span aria-hidden className="text-muted-foreground transition-transform group-open:rotate-180">
                      {'\u2304'}
                    </span>
                  </summary>
                  <p className="text-muted-foreground pb-5 text-sm">{item.a}</p>
                </details>
              ))}
            </div>
          </div>
        </section>
      </main>

      {/* The one footer: the close, the legal links, and the field the page
          scrolls over. Same shape as the loopmaxxing footer: one centered
          close, no link columns, then the ridge rises under the last screen. */}
      <footer className="relative isolate overflow-clip bg-background">
        <div className="relative z-10">
          <div className={cn(COLUMN, 'flex flex-col items-center gap-7 pt-32 pb-24 text-center lg:pt-48')}>
            <h2 className="text-foreground text-4xl tracking-tight text-balance sm:text-5xl lg:text-6xl">
              Your company.
              <br />
              <span className="text-muted-foreground">Your agents.</span>
            </h2>
            <div className="flex flex-wrap items-center justify-center gap-3">
              <SignUp />
              <GhostButton href="/auth">Sign in</GhostButton>
            </div>
            <p className="text-muted-foreground text-sm">Free to start. Bring the model plan you already pay for.</p>
            <nav aria-label="Legal" className="text-muted-foreground flex gap-4 text-sm">
              <Link href="/legal?tab=privacy" className="hover:text-foreground transition-colors">
                Privacy
              </Link>
              <Link href="/legal/terms" className="hover:text-foreground transition-colors">
                Terms
              </Link>
            </nav>
          </div>
        </div>

        {/* The ridge: a spacer, then a field pinned to the bottom edge as the page ends. */}
        <div aria-hidden className="h-[56svh] min-h-[320px]" />
        <div aria-hidden className="pointer-events-none sticky bottom-0 z-0 h-0">
          <div className="absolute inset-x-0 bottom-0 h-[58svh] min-h-[330px] [mask-image:linear-gradient(to_top,#000_72%,transparent)]">
            <DitherRidge />
          </div>
        </div>
      </footer>
    </div>
  );
}
