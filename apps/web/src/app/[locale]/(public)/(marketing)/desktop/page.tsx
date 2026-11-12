import { surfaceRoute } from '@/features/marketing/surfaces/surface-page';

/** `/desktop`: copy in features/marketing/surfaces/content.ts, layout in surface-page.tsx. */
const { generateMetadata, Page } = surfaceRoute('desktop', '/desktop');

export { generateMetadata };
export default Page;
