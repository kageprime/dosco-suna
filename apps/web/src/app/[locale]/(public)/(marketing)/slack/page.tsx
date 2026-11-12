import { surfaceRoute } from '@/features/marketing/surfaces/surface-page';

/** `/slack`: copy in features/marketing/surfaces/content.ts, layout in surface-page.tsx. */
const { generateMetadata, Page } = surfaceRoute('slack', '/slack');

export { generateMetadata };
export default Page;
