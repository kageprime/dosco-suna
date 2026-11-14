import type { Metadata } from 'next';
import type { ReactNode } from 'react';

// A per-sign-in result page: never in a search index.
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default function ConnectorReturnLayout({ children }: { children: ReactNode }) {
  return children;
}
