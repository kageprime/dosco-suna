import { MarketingChrome } from '@/features/marketing/kit/marketing-chrome';
import { localeStaticParams } from '@/i18n/static-params';

export const generateStaticParams = localeStaticParams;

export default function SalesLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <MarketingChrome>{children}</MarketingChrome>;
}
