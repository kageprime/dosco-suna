'use client';

import { CtaSection } from '@/features/marketing/landing/cta-section';
import { cn } from '@/lib/utils';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { ThemeToggle } from './theme-toggle';

type FooterLinkItem = {
  label: string;
  href: string;
  external?: boolean;
};

type FooterSection = {
  title: string;
  links: FooterLinkItem[];
};

const FOOTER_SECTIONS: FooterSection[] = [
  {
    title: '火 Dosco',
    links: [
      { label: 'Dosco', href: '/' },
      { label: 'Privacy', href: '/legal?tab=privacy' },
      { label: 'Terms', href: '/legal/terms' },
    ],
  },
];

function FooterLink({ label, href, external }: FooterLinkItem) {
  const className = cn(
    'group flex w-full min-w-0 items-baseline py-1 text-sm hover:text-foreground text-muted-foreground/90 whitespace-nowrap',
  );

  if (external) {
    return (
      <Link href={href} target="_blank" rel="noopener noreferrer" className={className}>
        <span className="min-w-0">{label}</span>
      </Link>
    );
  }

  return (
    <Link href={href} className={className}>
      <span className="min-w-0">{label}</span>
    </Link>
  );
}

const Footer = () => {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const currentYear = new Date().getFullYear();

  return (
    <section className="from-card to-background relative overflow-hidden border-t bg-linear-to-b from-30% to-90% pt-12 pb-12 md:pb-16">
      <CtaSection />

      <footer id="site-footer" className="relative z-10">
        <div className="mx-auto mb-12 max-w-7xl px-6">
          <nav>
            <div className="grid grid-cols-2 gap-x-6 gap-y-8 md:grid-cols-5">
              {FOOTER_SECTIONS.map((section) => (
                <div key={section.title} className="min-w-0 space-y-2">
                  <h3 className="text-foreground text-sm">{section.title}</h3>
                  <ul className="space-y-0">
                    {section.links.map((link) =>
                      process.env.NEXT_PUBLIC_USE_CASES_ENABLED === 'false' &&
                      link.href === '/use-cases' ? null : (
                        <li key={link.label}>
                          <FooterLink {...link} />
                        </li>
                      ),
                    )}
                  </ul>
                </div>
              ))}
            </div>
          </nav>
        </div>

        <div className="mx-auto flex max-w-7xl flex-col items-start justify-between gap-4 border-t p-6 md:flex-row md:items-center">
          <div className="text-muted-foreground flex items-center gap-3 text-base">
            <small>
              {tI18nHardcoded.raw('autoComponentsHomeFooterJsxTextCopye99743e8')}
              {currentYear} Dosco
            </small>
          </div>

          <ThemeToggle variant="compact" systemTheme={false} />
        </div>
      </footer>
    </section>
  );
};

export default Footer;
