'use client';

import { setupPromptFor } from '@kortix/shared/setup-guide';
import { cn } from '@kortix/ui';
import { KortixLogo } from '@/components/sidebar/kortix-logo';
import Link from 'next/link';
import { type CSSProperties } from 'react';

import { YamlLine } from '@/features/marketing/code-panel';
import { DitherField } from '@/features/marketing/kit/dither-field';
import { ENGINE, MANIFEST, TOOLS } from '@/features/marketing/one-prompt/factory-content';
import type { LoopView } from '@/features/marketing/one-prompt/loops-content';
import { CopyButton, Eyebrow, GhostButton, Mark, useCopy, useSetupTarget } from '@/features/marketing/one-prompt/parts';

import { RoleCards } from './role-cards';

const COLUMN = 'mx-auto w-full max-w-[1192px]';
const H2 = 'text-foreground text-3xl font-medium tracking-tight text-balance lg:text-[40px] lg:leading-tight';
const BODY = 'text-muted-foreground max-w-xl text-base text-pretty';

/** A low light in the brand blue, rising from one point. Art only. */
const light = (at: string, strength = 30): CSSProperties => ({
  backgroundImage: `radial-gradient(55% 90% at ${at}, color-mix(in oklch, var(--kortix-base) ${strength}%, transparent), transparent 70%)`,
});

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

/** The one action of the page: copy the prompt, then paste it into a coding agent. */
function PromptBox({ className }: { className?: string }) {
  const prompt = setupPromptFor(useSetupTarget());
  const { copied, copy } = useCopy(prompt);
  return (
    <button
      type="button"
      onClick={copy}
      className={cn(
        'border-border bg-card hover:border-kortix-base group flex w-full max-w-xl flex-col gap-5 rounded-xl border p-5 text-left shadow-2xl backdrop-blur transition-colors',
        className,
      )}
    >
      <span className="text-foreground block font-mono text-[13px] leading-6 whitespace-pre-wrap">{prompt}</span>
      <span
        aria-live="polite"
        className="bg-kortix-base group-hover:bg-kortix-base self-end rounded-md px-3 py-1.5 text-sm font-medium whitespace-nowrap text-primary-foreground transition-colors"
      >
        {copied ? 'Copied' : 'Copy the setup prompt'}
      </span>
    </button>
  );
}

const proof = (roles: LoopView[]) => [
  { value: String(roles.length).padStart(2, '0'), label: 'ready roles' },
  { value: '01', label: 'kortix.yaml' },
  { value: '3,000+', label: 'app connectors' },
  { value: '24/7', label: 'cloud work' },
];

/**
 * The Dosco landing. One person leads; capable agents hold the roles. The
 * roles, the counts and the YAML on this page come from the build's real
 * starter templates, so the page shows what the product actually ships.
 */
export function CeoHome({ roles, catalog }: { roles: LoopView[]; catalog: string[] }) {
  return (
    <div className="dark bg-background text-foreground relative min-h-screen overflow-x-clip">
      <header className="border-border bg-background/80 sticky top-0 z-30 border-b backdrop-blur">
        <div className={cn(COLUMN, 'border-border flex h-16 items-center justify-between border-x px-8 md:px-10')}>
          <div className="flex items-center gap-4">
            <Link href="/" aria-label="Dosco" className="text-foreground">
              <KortixLogo size={16} variant="logomark" />
            </Link>
            <span className="text-foreground font-mono text-sm font-medium tracking-wider uppercase">CompanyOS</span>
          </div>
          <nav className="text-muted-foreground hidden items-center gap-8 text-sm md:flex">
            <Link href="#roles" className="hover:text-foreground">
              Roles
            </Link>
            <Link href="#how" className="hover:text-foreground">
              How it works
            </Link>
            <Link href="#engine" className="hover:text-foreground">
              kortix.yaml
            </Link>
            <Link href="/docs/developers" className="hover:text-foreground">
              Docs
            </Link>
          </nav>
          <div className="flex items-center gap-2">
            <GhostButton href="/auth">Sign in</GhostButton>
            <CopyButton size="sm" text={setupPromptFor()} />
          </div>
        </div>
      </header>

      <main>
        {/* Full-bleed hero: the dither field and the light cross the viewport. */}
        <section className="border-border relative overflow-hidden border-b">
          <div aria-hidden className="pointer-events-none absolute inset-0" style={light('50% 130%', 34)} />
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-[46%] bottom-0 [mask-image:linear-gradient(to_bottom,transparent,#000_55%)]"
          >
            <DitherField className="text-kortix-base" />
          </div>
          <div className="relative mx-auto flex w-full max-w-[1192px] flex-col items-center gap-8 px-8 pt-20 pb-24 text-center md:px-10 lg:pt-24 lg:pb-28">
            <Eyebrow>CompanyOS</Eyebrow>
            <h1 className="text-foreground text-[40px] leading-tight font-medium tracking-tight sm:text-6xl lg:text-[72px]">
              Become the CEO.
              <br />
              <span className="text-kortix-base">Your company runs on agents.</span>
            </h1>
            <p className={BODY}>
              Start with capable agents in the roles every company needs. They work in the cloud around the clock and return finished work for your
              approval. You set the direction.
            </p>
            <PromptBox className="mt-2" />
            <p className="text-muted-foreground text-sm">
              Bring the model plan you already pay for, or any API key.
            </p>
          </div>
        </section>

        {/* Proof strip: four verifiable facts, no adjectives. */}
        <section aria-label="At a glance" className="border-border border-b">
          <dl className={cn(COLUMN, 'border-border grid border-x sm:grid-cols-2 lg:grid-cols-4')}>
            {proof(roles).map((item, index) => (
              <div
                key={item.label}
                className={cn(
                  'border-border flex items-baseline gap-4 px-8 py-6 md:px-10',
                  index > 0 && 'border-t sm:border-t-0 sm:border-l',
                )}
              >
                <dt className="text-kortix-base font-mono text-xl">{item.value}</dt>
                <dd className="text-muted-foreground text-sm">{item.label}</dd>
              </div>
            ))}
          </dl>
        </section>

        <div className={cn(COLUMN, 'border-border border-x')}>
          <section id="roles" className="scroll-mt-16">
            <div className="flex flex-col gap-3 px-8 pt-20 pb-8 md:px-10">
              <Eyebrow>The first team</Eyebrow>
              <h2 className={H2}>Every role your company needs, ready from day one.</h2>
              <p className={BODY}>
                Each role ships as a template with its own agent, triggers and skills. Point the setup at your repository and it configures the role with
                you.
              </p>
            </div>
            <RoleCards roles={roles} more={catalog} />
          </section>

          <section id="how" className="border-border scroll-mt-16 border-t">
            <div className="flex flex-col gap-3 px-8 pt-20 pb-12 md:px-10">
              <Eyebrow>How it works</Eyebrow>
              <h2 className={H2}>From one prompt to an operating company.</h2>
            </div>
            <ol className="border-border grid border-t sm:grid-cols-2 lg:grid-cols-4">
              {STEPS.map((step, index) => (
                <li
                  key={step.title}
                  className="border-border flex flex-col gap-3 border-b p-6 md:p-8 lg:border-r lg:border-b-0 lg:last:border-r-0"
                >
                  <span className="text-kortix-base font-mono text-xs">{String(index + 1).padStart(2, '0')}</span>
                  <span className="text-foreground text-lg font-medium tracking-tight">{step.title}</span>
                  <span className="text-muted-foreground text-sm text-pretty">{step.body}</span>
                </li>
              ))}
            </ol>
          </section>

          <section id="engine" className="border-border scroll-mt-16 border-t">
            <div className="flex flex-col gap-3 px-8 pt-20 pb-12 md:px-10">
              <Eyebrow>Under the hood</Eyebrow>
              <h2 className={H2}>One file defines the company.</h2>
              <p className={BODY}>
                kortix.yaml names every agent, what starts it and what it may touch. You review it the same way you review code.
              </p>
            </div>
            <div className="border-border grid border-t lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]">
              <div className="border-border border-b p-6 md:p-8 lg:border-r lg:border-b-0">
                <div className="border-border bg-card overflow-hidden rounded-lg border">
                  <div className="border-border text-muted-foreground border-b px-4 py-2.5 font-mono text-xs">kortix.yaml</div>
                  <pre className="overflow-x-auto px-5 py-5 font-mono text-xs leading-6">
                    {MANIFEST.map((line, i) => (
                      <span key={i} className="block whitespace-pre">
                        {line === '' ? ' ' : <YamlLine line={line} />}
                      </span>
                    ))}
                  </pre>
                </div>
              </div>
              <dl className="grid content-start sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
                {ENGINE.map((part) => (
                  <div
                    key={part.term}
                    className="border-border flex flex-col gap-2 border-b p-6 md:p-8 sm:odd:border-r lg:odd:border-r-0 xl:odd:border-r"
                  >
                    <dt className="text-foreground flex items-baseline gap-3 text-base font-medium">
                      {part.term}
                      <span className="text-kortix-base font-mono text-xs font-normal">{part.key}</span>
                    </dt>
                    <dd className="text-muted-foreground text-sm text-pretty">{part.body}</dd>
                  </div>
                ))}
              </dl>
            </div>
          </section>

          <section className="border-border grid border-t md:grid-cols-2">
            <div className="border-border flex flex-col gap-4 border-b p-8 md:border-r md:border-b-0 md:p-10">
              <h2 className="text-foreground text-3xl font-medium tracking-tight">Questions.</h2>
              <p className="text-muted-foreground text-sm">
                <Link href="/contact" className="text-foreground underline underline-offset-4">
                  Talk to the team
                </Link>
              </p>
            </div>
            <div>
              {FAQ.map((item) => (
                <details key={item.q} className="border-border group border-b last:border-b-0">
                  <summary className="text-foreground flex cursor-pointer list-none items-center justify-between px-6 py-4 text-sm font-medium">
                    {item.q}
                    <span aria-hidden className="text-muted-foreground transition-transform group-open:rotate-180">
                      ⌄
                    </span>
                  </summary>
                  <p className="text-muted-foreground px-6 pb-5 text-sm">{item.a}</p>
                </details>
              ))}
            </div>
          </section>
        </div>

        {/* Closing call to action, full bleed like the hero. */}
        <section className="border-border relative overflow-hidden border-t">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 opacity-80 [mask-image:linear-gradient(to_bottom,transparent,#000_70%)]"
          >
            <DitherField className="text-kortix-base" />
          </div>
          <div className="relative mx-auto flex w-full max-w-[1192px] flex-col items-center gap-8 px-8 py-28 text-center md:px-10">
            <h2 className="text-foreground text-4xl font-medium tracking-tight text-balance lg:text-6xl">
              Your company.
              <br />
              Your agents.
            </h2>
            <p className="text-muted-foreground max-w-md text-base">
              Bring the <Mark name="Claude" /> or <Mark name="Codex" /> plan you already pay for, or any API key.
            </p>
            <ul className="text-muted-foreground flex max-w-2xl flex-wrap justify-center gap-x-8 gap-y-3 text-sm">
              {TOOLS.filter((tool) => tool !== 'Claude Code' && tool !== 'Codex').map((tool) => (
                <li key={tool}>{tool}</li>
              ))}
            </ul>
            <PromptBox />
          </div>
        </section>
      </main>

      {/* The one footer. The old marketing shell's footer is not on this route. */}
      <footer className="border-border grid gap-10 border-t px-8 py-14 sm:grid-cols-3 md:px-10">
        {[
          {
            title: 'Product',
            links: [
              ['Roles', '#roles'],
              ['How it works', '#how'],
              ['kortix.yaml', '#engine'],
            ],
          },
          {
            title: 'Developers',
            links: [
              ['Docs', '/docs/developers'],
              ['Setup guide', '/setup.md'],
              ['Loopmaxxing', '/loopmaxxing'],
            ],
          },
          {
            title: 'Company',
            links: [
              ['Dosco', '/'],
              ['Contact', '/contact'],
              ['Terms', '/legal/terms'],
            ],
          },
        ].map((group) => (
          <div key={group.title} className="flex flex-col gap-3 text-sm">
            <span className="text-muted-foreground">{group.title}</span>
            {group.links.map(([label, href]) => (
              <Link key={label} href={href} className="text-foreground hover:text-muted-foreground">
                {label}
              </Link>
            ))}
          </div>
        ))}
      </footer>
      <div className="border-border text-muted-foreground border-t px-8 py-6 text-center text-xs md:px-10">
        Dosco Tek is the harness that powers companies that run agents.
      </div>
    </div>
  );
}
