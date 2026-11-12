import { surfaceRoute } from '@/features/marketing/surfaces/surface-page';

/** `/mobile`: copy in features/marketing/surfaces/content.ts, layout in surface-page.tsx. */
const { generateMetadata, Page } = surfaceRoute('mobile', '/mobile');

export { generateMetadata };
export default Page;
