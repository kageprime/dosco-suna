import { surfaceRoute } from '@/features/marketing/surfaces/surface-page';

/** `/teams`: copy in features/marketing/surfaces/content.ts, layout in surface-page.tsx. */
const { generateMetadata, Page } = surfaceRoute('teams', '/teams');

export { generateMetadata };
export default Page;
