import { cn } from '@kortix/ui';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { requireLoopmaxxing } from '@/lib/loopmaxxing-gate';

import { roobert } from '@/app/(system)/fonts/roobert';
import { roobertMono } from '@/app/(system)/fonts/roobert-mono';

// Its own site: the page is canonical at loopmaxxing.sh, and it stays out of
// kortix.com's sitemap and public content list.
export const metadata: Metadata = {
  title: 'Loopmaxxing by Dosco: add a software factory to your repo with 1 prompt',
  description:
    'For dev teams. Agents that work on your repo and your tools, in the cloud, 24/7. One prompt in Claude Code or Codex sets them up, on the plan you already pay for. You approve what ships.',
  alternates: { canonical: 'https://loopmaxxing.sh' },
};

export default async function LoopmaxxingLayout({ children }: { children: ReactNode }) {
  await requireLoopmaxxing();
  // The reference fold's type system, scoped to this page (globals.css: `.font-marketing`).
  return <div className={cn(roobert.variable, roobertMono.variable, 'font-marketing')}>{children}</div>;
}
