'use client';

import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { DitherField } from '@/features/marketing/kit/dither-field';
import { loopPrompt, setupPromptFor } from '@kortix/shared/setup-guide';
import { cn } from '@kortix/ui';
import Link from 'next/link';
import { type CSSProperties } from 'react';

import { YamlLine } from '@/features/marketing/code-panel';

import { ENGINE, FAQ, MANIFEST, TOOLS } from './factory-content';
import { FactoryStack } from './factory-stack';
import type { LoopView } from './loops-content';
import { CopyButton, Eyebrow, GhostButton, Mark, useCopy, useSetupTarget } from './parts';

/** The company site: this page is one product of it. */
const DOSCO_URL = 'https://dosco.live';

/** The column every section sits in, between the two hairline rails. */
const COLUMN = 'mx-auto w-full max-w-[1192px]';
const H2 = 'text-foreground text-3xl font-medium tracking-tight text-balance lg:text-[40px] lg:leading-tight';

/** A low light in the brand blue, rising from one point. Art only. */
const light = (at: string, strength = 30): CSSProperties => ({
  backgroundImage: `radial-gradient(55% 90% at ${at}, color-mix(in oklch, var(--kortix-base) ${strength}%, transparent), transparent 70%)`,
});

/** What the one prompt does, in order: the onboarding is the product. */
const STEPS = [
  { title: 'Finds your software.', body: 'It scans the codebase for every tool you use and asks about the ones it cannot see. Names only, never a secret value.' },
  { title: 'Connects it.', body: 'Secrets, 3,000+ app connectors, Slack and an environment built from your repo.' },
  { title: 'Sets the signals.', body: 'Issues, merges, errors, messages, signups, schedules. You pick what the agents listen to.' },
  { title: 'Runs your loops.', body: 'A ready-made factory or any loop you describe. All of it in one kortix.yaml.' },
  { title: 'Proves it, then stays.', body: 'It loops until one real run finishes. Then it adds the Dosco MCP server to your coding agent, so the next loop is one sentence.' },
];

/** The prompt itself, as the thing to click: the page's one action. */
function PromptBox({ loop, className }: { loop?: LoopView; className?: string }) {
  const target = useSetupTarget();
  const prompt = loop ? loopPrompt(loop, target) : setupPromptFor(target);
  const { copied, copy } = useCopy(prompt);
  return (
    <button
      type="button"
      onClick={copy}
      className={cn(
        'border-border bg-card/80 hover:border-kortix-base/60 group flex w-full max-w-xl flex-col gap-5 rounded-xl border p-5 text-left shadow-2xl shadow-black/40 backdrop-blur transition-colors',
        className,
      )}
    >
      <span className="text-foreground/90 block font-mono text-[13px] leading-6 whitespace-pre-wrap">{prompt}</span>
      <span aria-live="polite" className="bg-kortix-base group-hover:bg-kortix-base/90 self-end rounded-md px-3 py-1.5 text-sm font-medium whitespace-nowrap text-white transition-colors">
        {copied ? 'Copied' : 'Copy the prompt'}
      </span>
    </button>
  );
}

/**
 * Loopmaxxing (loopmaxxing.sh), the developer landing. One job: get a developer to copy the prompt. The hero is the
 * prompt; the stack shows what each factory does, one clip per team; three
 * steps, the kortix.yaml section and the FAQ answer what is left. The frame (one
 * railed column, hairlines) is after wonder.design; the blue, the dither field
 * and every word are Kortix's own.
 */
export function FactoryHome({ loops, catalog }: { loops: LoopView[]; catalog: string[] }) {
  // The factory the page leads with: its name is the headline, its prompt is the one to copy.
  const first = loops[0];
  const target = useSetupTarget();
  const prompt = first ? loopPrompt(first, target) : undefined;
  return (
    <div className="dark bg-background text-foreground relative min-h-screen overflow-x-clip">
      <div className={cn(COLUMN, 'border-border relative border-x')}>
        <header className="border-border bg-background/80 sticky top-0 z-30 flex h-16 items-center justify-between border-b px-8 backdrop-blur md:px-10">
          <div className="flex items-center gap-4">
            <a href={DOSCO_URL} aria-label="Dosco" className="text-foreground">
              <KortixLogo size={16} variant="logomark" />
            </a>
            <span className="text-foreground font-mono text-sm font-medium tracking-wider uppercase">Factories</span>
          </div>
          <nav className="text-muted-foreground hidden items-center gap-8 text-sm md:flex">
            <Link href="#factories" className="hover:text-foreground">Factories</Link>
            <Link href="#how" className="hover:text-foreground">How it works</Link>
            <Link href="#engine" className="hover:text-foreground">kortix.yaml</Link>
            <Link href="/docs/developers" className="hover:text-foreground">Docs</Link>
          </nav>
          <div className="flex items-center gap-2">
            <GhostButton href="/auth">Sign in</GhostButton>
            <CopyButton size="sm" text={prompt} />
          </div>
        </header>

        <section className="relative overflow-hidden">
          <div aria-hidden className="pointer-events-none absolute inset-x-0 top-[46%] bottom-0 [mask-image:linear-gradient(to_bottom,transparent,#000_55%)]">
            <DitherField className="text-kortix-base" />
          </div>
          <div className="relative flex flex-col items-center gap-8 px-8 pt-20 pb-24 text-center md:px-10 lg:pt-24 lg:pb-28">
            <span className="border-border bg-card text-muted-foreground inline-flex items-center rounded-full border px-3 py-1 text-sm">
              For dev teams
            </span>
            <h1 className="text-foreground text-[40px] leading-[1.04] font-medium tracking-tight sm:text-6xl lg:text-[72px]">
              Add a <span className="text-kortix-base">{first?.name ?? 'Software Factory'}</span>
              <br />
              with 1 prompt.
            </h1>
            <p className="text-foreground/70 max-w-xl text-lg text-pretty">
              Agents that work on your repo and your tools, in the cloud, 24/7. One prompt in <Mark name="Claude Code" /> or{' '}
              <Mark name="Codex" /> sets them up. You approve what ships.
            </p>
            <PromptBox loop={first} className="mt-2" />
          </div>
        </section>

        <section id="how" className="border-border scroll-mt-16 border-t">
          <div className="flex flex-col gap-3 px-8 pt-20 pb-12 md:px-10">
            <Eyebrow>What the one prompt does</Eyebrow>
            <h2 className={H2}>Connect your stack. Pick your signals. Run your loops.</h2>
          </div>
          <ol className="border-border grid border-t sm:grid-cols-2 lg:grid-cols-5">
            {STEPS.map((step, index) => (
              <li key={step.title} className="border-border flex flex-col gap-3 border-b p-6 md:p-8 lg:border-r lg:border-b-0 lg:last:border-r-0">
                <span className="text-kortix-base font-mono text-xs">{String(index + 1).padStart(2, '0')}</span>
                <span className="text-foreground text-lg font-medium tracking-tight">{step.title}</span>
                <span className="text-muted-foreground text-sm text-pretty">{step.body}</span>
              </li>
            ))}
          </ol>
        </section>

        <section id="factories" className="border-border scroll-mt-16 border-t">
          <div className="flex flex-col gap-3 px-8 pt-20 pb-12 md:px-10">
            <Eyebrow>The first template</Eyebrow>
            <h2 className={H2}>Start with the {first?.name ?? 'Software Factory'}.</h2>
          </div>
          <FactoryStack loops={loops} more={catalog} />
        </section>

        <section className="border-border relative overflow-hidden border-t">
          <div aria-hidden className="pointer-events-none absolute inset-0" style={light('15% 120%', 34)} />
          <div aria-hidden className="pointer-events-none absolute inset-0" style={light('90% 130%', 18)} />
          <div className="relative flex flex-col items-center gap-8 px-8 py-24 text-center">
            <h2 className={cn(H2, "max-w-2xl")}>Bring the plan you already pay for.</h2>
            <p className="text-muted-foreground max-w-md text-base">
              Your <Mark name="Claude" /> or <Mark name="Codex" /> subscription, or any API key. A 3 a.m. run uses it too.
            </p>
            <ul className="text-muted-foreground flex max-w-2xl flex-wrap justify-center gap-x-8 gap-y-3 text-sm">
              {TOOLS.filter((tool) => tool !== 'Claude Code' && tool !== 'Codex').map((tool) => (
                <li key={tool}>{tool}</li>
              ))}
            </ul>
          </div>
        </section>

        <section id="engine" className="border-border scroll-mt-16 border-t">
          <div className="flex flex-col gap-3 px-8 pt-20 pb-12 md:px-10">
            <Eyebrow>Under the hood</Eyebrow>
            <h2 className={H2}>One file in your repo runs all of it.</h2>
            <p className="text-muted-foreground max-w-xl text-base text-pretty">
              You connect your repo. The setup adds kortix.yaml. It defines every agent, what starts it and what it may touch. You review it like code.
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
                <div key={part.term} className="border-border flex flex-col gap-2 border-b p-6 md:p-8 sm:odd:border-r lg:odd:border-r-0 xl:odd:border-r">
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
              <Link href="/contact" className="text-foreground underline underline-offset-4">Talk to the team</Link>
            </p>
          </div>
          <div>
            {FAQ.map((item) => (
              <details key={item.q} className="border-border group border-b last:border-b-0">
                <summary className="text-foreground flex cursor-pointer list-none items-center justify-between px-6 py-4 text-sm font-medium">
                  {item.q}
                  <span aria-hidden className="text-muted-foreground transition-transform group-open:rotate-180">⌄</span>
                </summary>
                <p className="text-muted-foreground px-6 pb-5 text-sm">{item.a}</p>
              </details>
            ))}
          </div>
        </section>

        <section className="border-border relative overflow-hidden border-t">
          <div aria-hidden className="pointer-events-none absolute inset-0 opacity-80 [mask-image:linear-gradient(to_bottom,transparent,#000_70%)]">
            <DitherField className="text-kortix-base" />
          </div>
          <div className="relative flex flex-col items-center gap-8 px-8 py-28 text-center">
            <h2 className="text-foreground text-4xl font-medium tracking-tight text-balance lg:text-6xl">
              One prompt.
              <br />
              Your whole company, looped.
            </h2>
            <PromptBox loop={first} />
          </div>
        </section>

        <footer className="border-border grid gap-10 border-t px-8 py-14 sm:grid-cols-4 md:px-10">
          {[
            { title: 'Product', links: [['Factories', '#factories'], ['How it works', '#how'], ['kortix.yaml', '#engine']] },
            { title: 'Developers', links: [['Docs', '/docs/developers'], ['The setup guide', '/setup.md']] },
            { title: 'Company', links: [['Dosco', DOSCO_URL], ['Careers', '/careers']] },
            { title: 'Legal', links: [['Terms', '/legal/terms'], ['Privacy', '/legal?tab=privacy']] },
          ].map((group) => (
            <div key={group.title} className="flex flex-col gap-3 text-sm">
              <span className="text-muted-foreground">{group.title}</span>
              {group.links.map(([label, href]) => (
                <Link key={label} href={href!} className="text-foreground hover:text-muted-foreground">
                  {label}
                </Link>
              ))}
            </div>
          ))}
        </footer>
        <div className="border-border text-muted-foreground border-t px-8 py-6 text-center text-xs md:px-10">Autonomous Software Factories, by Dosco Tek.</div>
      </div>
    </div>
  );
}
