'use client';

import { CtaSection } from '@/features/marketing/landing/cta-section';
import { FOOTER_TRANSLATION_KEYS } from '@/i18n/footer-translation-keys.generated';
import { localizeUiCatalog } from '@kortix/ui/i18n';
import { cn } from '@kortix/ui';
import { useTranslations } from '@/i18n/use-translations';
import Link from '@/components/site-link';
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

/**
 * Five columns, restored in the 2026-10-20 footer rebuild — "some of the footer
 * links, the ones that make sense": the shipped sitemap routes only. Every
 * label except 'Contact', 'CLI', 'SDK' and 'Subprocessors' already carries a
 * generated translation key, so the columns localize without catalog edits.
 * Kortix-owned surfaces the old footer pointed at (x.com/kortix,
 * linkedin.com/company/kortix, status.kortix.com, github.com/kortix-ai/suna)
 * stay out: the footer links to routes Dosco serves plus one Dosco mailbox.
 */
const FOOTER_SECTIONS: FooterSection[] = [
  {
    title: 'Product',
    links: [
      { label: 'Agent Computer', href: '/agent-computer' },
      { label: 'Agents & Skills', href: '/agents-and-skills' },
      { label: 'Company as Code', href: '/company-as-code' },
      { label: 'Connectors', href: '/connectors' },
      { label: 'Automations', href: '/automations' },
      { label: 'Channels', href: '/channels' },
      { label: 'Security', href: '/security' },
      { label: 'Enterprise', href: '/enterprise' },
      { label: 'Pricing', href: '/pricing' },
      { label: 'Download', href: '/download' },
    ],
  },
  {
    // Pulled out of the top bar: eight roles is a wide menu beside Product and
    // Company, and a reader looking for their own function looks down here.
    title: 'Solutions',
    links: [
      { label: 'Sales', href: '/solutions/sales' },
      { label: 'Marketing', href: '/solutions/marketing' },
      { label: 'Engineering', href: '/solutions/engineering' },
      { label: 'Product', href: '/solutions/product' },
      { label: 'Finance', href: '/solutions/finance' },
      { label: 'People', href: '/solutions/people' },
      { label: 'IT', href: '/solutions/it' },
      { label: 'Data Science', href: '/solutions/data-science' },
    ],
  },
  {
    title: 'Developers',
    links: [
      { label: 'Documentation', href: '/docs' },
      { label: 'Quickstart', href: '/docs/quickstart' },
      { label: 'Marketplace', href: '/marketplace' },
    ],
  },
  {
    title: 'Company',
    links: [
      { label: 'Careers', href: '/careers' },
      { label: 'Changelog', href: '/changelog' },
      { label: 'Use Cases', href: '/use-cases' },
      { label: 'Brand', href: '/design-system' },
    ],
  },
  {
    title: 'Connect',
    links: [
      { label: 'Support', href: '/support' },
      { label: 'Contact', href: 'mailto:support@dosco.live' },
    ],
  },
];

/** Legal surfaces sit one level below the column grid: the copyright row owns
 *  them, so the five columns stay product-shaped. */
const FOOTER_LEGAL_LINKS: FooterLinkItem[] = [
  { label: 'Privacy', href: '/legal?tab=privacy' },
  { label: 'Terms', href: '/legal/terms' },
  { label: 'Subprocessors', href: '/legal/subprocessors' },
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
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const footerSections = localizeUiCatalog(FOOTER_SECTIONS, tI18nComplete, FOOTER_TRANSLATION_KEYS);
  const legalLinks = localizeUiCatalog(FOOTER_LEGAL_LINKS, tI18nComplete, FOOTER_TRANSLATION_KEYS);
  const currentYear = new Date().getFullYear();

  return (
    <section className="from-card to-background relative overflow-hidden border-t bg-linear-to-b from-30% to-90% pt-12">
      <CtaSection />

      <footer id="site-footer" className="relative z-10">
        <div className="mx-auto mb-12 max-w-7xl px-6">
          <nav>
            <div className="grid grid-cols-2 gap-x-6 gap-y-8 md:grid-cols-5">
              {footerSections.map((section) => (
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
              {currentYear} {tI18nHardcoded.raw('i18nComplete.textab54cf5e1d9d')}
            </small>
          </div>

          <div className="flex items-center gap-6">
            <nav className="flex items-center gap-4" aria-label="Legal">
              {legalLinks.map((l) => (
                <Link
                  key={l.label}
                  href={l.href}
                  className="text-muted-foreground hover:text-foreground whitespace-nowrap text-sm"
                >
                  {l.label}
                </Link>
              ))}
            </nav>

            <ThemeToggle variant="compact" systemTheme={false} />
          </div>
        </div>
      </footer>

      {/* Dithered wordmark: an alpha mask painted with the foreground token, so it follows the theme. */}
      <div
        aria-hidden
        className="bg-foreground mx-auto mt-6 aspect-[1440/308] w-full max-w-7xl opacity-15"
        style={{
          maskImage: 'url(/marketing/dither-wordmark.png)',
          WebkitMaskImage: 'url(/marketing/dither-wordmark.png)',
          maskSize: 'contain',
          WebkitMaskSize: 'contain',
          maskRepeat: 'no-repeat',
          WebkitMaskRepeat: 'no-repeat',
          maskPosition: 'bottom',
          WebkitMaskPosition: 'bottom',
        }}
      />
    </section>
  );
};

export default Footer;
