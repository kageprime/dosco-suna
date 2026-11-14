import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { requireLoopmaxxing } from '@/lib/loopmaxxing-gate';

// Its own site: the page is canonical at loopmaxxing.sh, and it stays out of
// kortix.com's sitemap and public content list.
export const metadata: Metadata = {
  title: 'Loopmaxxing by Kortix: add a software factory to your repo with 1 prompt',
  description:
    'For dev teams. Agents that work on your repo and your tools, in the cloud, 24/7. One prompt in Claude Code or Codex sets them up, on the plan you already pay for. You approve what ships.',
  alternates: { canonical: 'https://loopmaxxing.sh' },
};

export default async function LoopmaxxingLayout({ children }: { children: ReactNode }) {
  await requireLoopmaxxing();
  return children;
}
