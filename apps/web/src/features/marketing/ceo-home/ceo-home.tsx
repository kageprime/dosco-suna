'use client';

import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { DitherField } from '@/features/marketing/kit/dither-field';
import { setupPromptFor } from '@kortix/shared/setup-guide';
import { cn } from '@kortix/ui';
import Link from 'next/link';
import { type CSSProperties } from 'react';

import { YamlLine } from '@/features/marketing/code-panel';
import { MANIFEST } from '@/features/marketing/one-prompt/factory-content';
import { CopyButton, Eyebrow, GhostButton, useCopy, useSetupTarget } from '@/features/marketing/one-prompt/parts';

/** The column every section sits in, between the two hairline rails. */
const COLUMN = 'mx-auto w-full max-w-[1192px]';
const H2 = 'text-foreground text-3xl font-medium tracking-tight text-balance lg:text-[40px] lg:leading-tight';

const light = (at: string, strength = 30): CSSProperties => ({
  backgroundImage: `radial-gradient(55% 90% at ${at}, color-mix(in oklch, var(--kortix-base) ${strength}%, transparent), transparent 70%)`,
});

/** The roles a person starts with, read from the shipped templates. */
export interface CeoRole {
  team: string;
  line: string;
}

const STEPS = [
  { title: 'Name the company.', body: 'Connect a repository. It becomes the workspace: agents, skills, connectors and memory in one place you own.' },
  { title: 'Pick the roles.', body: 'Start with engineering, marketing, sales, support and recruiting. Every agent gets its own job and its own cloud computer.' },
  { title: 'Set the signals.', body: 'Issues, merges, errors, messages, signups or a schedule. You choose what each role listens to.' },
  { title: 'Review the work.', body: 'An agent opens a change request. Nothing merges itself unless you grant that capability. You decide what ships.' },
];

const FAQ = [
  {
    q: 'Do I need to hire a team first?',
    a: 'No. Start with the roles the templates ship. Each agent has a job, a cloud computer and a change request path back to your repository.',
  },
  {
    q: 'Which models do the agents use?',
    a: 'Any model provider with your own keys. Or the ChatGPT plan you already pay for.',
  },
  {
    q: 'What stops an agent from shipping something I did not approve?',
    a: 'Session work reaches main through a change request. Merge is default-deny for agents.',
  },
  {
    q: 'Can I connect the tools my company already uses?',
    a: '3,000+ apps in a click, plus MCP, OpenAPI, Postman, GraphQL and raw HTTP. Connector credentials are brokered server-side and never enter the machine.',
  },
];

function PromptBox({ className }: { className?: string }) {
  const target = useSetupTarget();
  const prompt = setupPromptFor(target);
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
      <span aria-live="polite" className="bg-kortix-base group-hover:bg-kortix-base self-end rounded-md px-3 py-1.5 text-sm font-medium whitespace-nowrap text-primary-foreground transition-colors">
        {copied ? 'Copied' : 'Copy the prompt'}
      </span>
    </button>
  );
}

/**
 * The Dosco landing: anyone can become the CEO of a company that runs agents.
 * The roles, the copyable prompt and the real kortix.yaml excerpt are the proof.
 */
export function CeoHome({ roles }: { roles: CeoRole[] }) {
  return (
    <div className="dark bg-background text-foreground relative min-h-screen overflow-x-clip">
      <div className={cn(COLUMN, 'border-border relative border-x')}>
        <header className="border-border bg-background/80 sticky top-0 z-30 flex h-16 items-center justify-between border-b px-8 backdrop-blur md:px-10">
          <div className="flex items-center gap-4">
            <Link href="/" aria-label="Dosco" className="text-foreground">
              <KortixLogo size={16} variant="logomark" />
            </Link>
            <span className="text-foreground font-mono text-sm font-medium tracking-wider uppercase">CompanyOS</span>
          </div>
          <nav className="text-muted-foreground hidden items-center gap-8 text-sm md:flex">
            <Link href="#roles" className="hover:text-foreground">Roles</Link>
            <Link href="#how" className="hover:text-foreground">How it works</Link>
            <Link href="#engine" className="hover:text-foreground">kortix.yaml</Link>
            <Link href="/docs/developers" className="hover:text-foreground">Docs</Link>
          </nav>
          <div className="flex items-center gap-2">
            <GhostButton href="/auth">Sign in</GhostButton>
            <CopyButton size="sm" text={setupPromptFor()} />
          </div>
        </header>

        <section className="relative overflow-hidden">
          <div aria-hidden className="pointer-events-none absolute inset-x-0 top-[46%] bottom-0 [mask-image:linear-gradient(to_bottom,transparent,#000_55%)]">
            <DitherField className="text-kortix-base" />
          </div>
          <div className="relative flex flex-col items-center gap-8 px-8 pt-20 pb-24 text-center md:px-10 lg:pt-24 lg:pb-28">
            <span className="border-border bg-card text-muted-foreground inline-flex items-center rounded-full border px-3 py-1 text-sm">
              For anyone who wants to run a company
            </span>
            <h1 className="text-foreground text-[40px] leading-tight font-medium tracking-tight sm:text-6xl lg:text-[72px]">
              Become the CEO.
              <br />
              <span className="text-kortix-base">Start with the agents.</span>
            </h1>
            <p className="text-muted-foreground max-w-xl text-lg text-pretty">
              Capable agents in the roles your company needs. Each one does its job on its own cloud computer, in the cloud, 24/7. You approve what ships.
            </p>
            <PromptBox className="mt-2" />
          </div>
        </section>

        <section id="roles" className="border-border scroll-mt-16 border-t">
          <div className="flex flex-col gap-3 px-8 pt-20 pb-12 md:px-10">
            <Eyebrow>The first team</Eyebrow>
            <h2 className={H2}>A role for every part of the business.</h2>
            <p className="text-muted-foreground max-w-xl text-base text-pretty">
              Start with the teams Dosco already knows how to run. Each role comes from a real template, with its own agents, triggers and skills.
            </p>
          </div>
          <ul className="border-border grid border-t sm:grid-cols-2 lg:grid-cols-5">
            {roles.map((role, index) => (
              <li key={role.team} className="border-border flex flex-col gap-3 border-b p-6 md:p-8 lg:border-r lg:border-b-0 lg:last:border-r-0">
                <span className="text-kortix-base font-mono text-xs">{String(index + 1).padStart(2, '0')}</span>
                <span className="text-foreground text-lg font-medium tracking-tight">{role.team}</span>
                <span className="text-muted-foreground text-sm text-pretty">{role.line}</span>
              </li>
            ))}
          </ul>
        </section>

        <section id="how" className="border-border scroll-mt-16 border-t">
          <div className="flex flex-col gap-3 px-8 pt-20 pb-12 md:px-10">
            <Eyebrow>How it works</Eyebrow>
            <h2 className={H2}>From one prompt to a company that runs.</h2>
          </div>
          <ol className="border-border grid border-t sm:grid-cols-2 lg:grid-cols-4">
            {STEPS.map((step, index) => (
              <li key={step.title} className="border-border flex flex-col gap-3 border-b p-6 md:p-8 lg:border-r lg:border-b-0 lg:last:border-r-0">
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
            <h2 className={H2}>One file in your repo runs all of it.</h2>
            <p className="text-muted-foreground max-w-xl text-base text-pretty">
              The setup adds kortix.yaml. It defines every agent, what starts it and what it may touch. You review it like code.
            </p>
          </div>
          <div className="border-border border-t p-6 md:p-8">
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
        </section>

        <section className="border-border relative overflow-hidden border-t">
          <div aria-hidden className="pointer-events-none absolute inset-0 opacity-80 [mask-image:linear-gradient(to_bottom,transparent,#000_70%)]">
            <DitherField className="text-kortix-base" />
          </div>
          <div className="relative flex flex-col items-center gap-8 px-8 py-28 text-center">
            <h2 className="text-foreground text-4xl font-medium tracking-tight text-balance lg:text-6xl">
              Your company.
              <br />
              Your agents.
            </h2>
            <p className="text-muted-foreground max-w-md text-base">
              Bring the ChatGPT plan you already pay for, or any API key.
            </p>
            <PromptBox />
          </div>
        </section>

        <section className="border-border grid border-t md:grid-cols-2">
          <div className="border-border flex flex-col gap-4 border-b p-8 md:border-r md:border-b-0 md:p-10">
            <h2 className="text-foreground text-3xl font-medium tracking-tight">Questions.</h2>
            <p className="text-muted-foreground text-sm">
              <Link href="/contact" className="text-foreground underline underline-offset-4">Talk to the team</Link>
            </p>
          </div>
          <div>
            {FAQ.map((item) => (
              <details key={item.q} className="border-border group border-b last:border-b-0">
                <summary className="text-foreground flex cursor-pointer list-none items-center justify-between px-6 py-4 text-sm font-medium">
                  {item.q}
                  <span aria-hidden className="text-muted-foreground transition-transform group-open:rotate-180">âŒ„</span>
                </summary>
                <p className="text-muted-foreground px-6 pb-5 text-sm">{item.a}</p>
              </details>
            ))}
          </div>
        </section>

        <footer className="border-border grid gap-10 border-t px-8 py-14 sm:grid-cols-4 md:px-10">
          {[
            { title: 'Product', links: [['Roles', '#roles'], ['How it works', '#how'], ['kortix.yaml', '#engine']] },
            { title: 'Developers', links: [['Docs', '/docs/developers'], ['The setup guide', '/setup.md']] },
            { title: 'Company', links: [['Dosco', '/'], ['Careers', '/careers']] },
            { title: 'Legal', links: [['Terms', '/legal/terms'], ['Privacy', '/legal?tab=privacy']] },
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
        <div className="border-border text-muted-foreground border-t px-8 py-6 text-center text-xs md:px-10">Dosco Tek is the harness that powers companies that run agents.</div>
      </div>
    </div>
  );
}
