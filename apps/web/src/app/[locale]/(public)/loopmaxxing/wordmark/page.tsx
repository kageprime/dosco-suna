import type { Metadata } from 'next';

import { WordmarkVariants } from '@/features/marketing/one-prompt/wordmark-variants';
import { requireLoopmaxxing } from '@/lib/loopmaxxing-gate';

// The wordmark's three "OO" variants side by side (founder call 2026-11-18: infinity is the default). Linked from nowhere.
export const metadata: Metadata = { title: 'Loopmaxxing wordmark', robots: { index: false, follow: false } };

export default async function LoopmaxxingWordmarkPage() {
  await requireLoopmaxxing();
  return <WordmarkVariants />;
}
