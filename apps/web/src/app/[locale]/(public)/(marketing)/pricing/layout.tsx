import { marketingMetadataLayout } from '@/lib/seo/metadata';

const { generateMetadata, Layout } = marketingMetadataLayout('/pricing');

export { generateMetadata };
export default Layout;
