import { marketingMetadataLayout } from '@/lib/seo/metadata';
import { requireServicesPages } from '@/lib/services-pages-gate';
import type { ReactNode } from 'react';

const { generateMetadata } = marketingMetadataLayout('/services');

export { generateMetadata };

export default async function ServicesLayout({ children }: { children: ReactNode }) {
  await requireServicesPages();
  return children;
}
