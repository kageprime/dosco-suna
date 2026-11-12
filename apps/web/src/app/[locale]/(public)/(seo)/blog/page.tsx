import type { Metadata } from 'next';

import { BlogCover } from '@/components/blog/blog-cover';
import { BlogFeaturedPost } from '@/components/blog/blog-post-card';
import { PostCard } from '@/components/blog/post-card';
import { EmptyState } from '@kortix/ui/empty-state';
import { MARKETING_CONTAINER } from '@/features/marketing/kit/section';
import { getTranslations } from '@/i18n/get-translations';
import { getAllPosts } from '@/lib/blog-posts';
import { safeJsonForHtml } from '@/lib/security/safe-json';
import { siteMetadata } from '@kortix/ui/internal/lib/site-metadata';
import { cn } from '@kortix/ui';

const TITLE = 'Blog';
const DESCRIPTION =
  'Field notes on building, running, and governing AI agents that do real work — from the team building the Dosco command center.';
const URL = `${siteMetadata.url}/blog`;

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  keywords: ['Dosco blog', 'AI agents', 'AI command center', 'AI workforce', 'agent automation'],
  openGraph: {
    type: 'website',
    title: `Dosco ${TITLE}`,
    description: DESCRIPTION,
    url: URL,
    siteName: 'Dosco',
    images: [{ url: `${siteMetadata.url}/banner.png` }],
  },
  twitter: {
    card: 'summary_large_image',
    title: `Dosco ${TITLE}`,
    description: DESCRIPTION,
    images: [`${siteMetadata.url}/banner.png`],
  },
  alternates: {
    canonical: URL,
    types: { 'application/rss+xml': `${URL}/rss.xml` },
  },
};

/**
 * The blog index, after Polar's blog: the two-tone title, the newest post as
 * a lead (title and description beside its cover), a hairline, then every
 * other post in a three-column grid. Posts are
 * `content/posts/*.md`.
 */
export default async function BlogIndexPage() {
  const tI18nHardcoded = await getTranslations('hardcodedUi');
  const posts = getAllPosts();
  const [lead, ...rest] = posts;

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Blog',
    name: 'Dosco Blog',
    description: DESCRIPTION,
    url: URL,
    publisher: {
      '@type': 'Organization',
      name: 'Dosco',
      logo: { '@type': 'ImageObject', url: `${siteMetadata.url}/favicon.svg` },
    },
    blogPost: posts.map((post) => ({
      '@type': 'BlogPosting',
      headline: post.data.title,
      description: post.data.description,
      datePublished: post.data.date,
      author: { '@type': 'Person', name: post.author.name },
      url: `${siteMetadata.url}${post.url}`,
    })),
  };

  return (
    <main className="bg-background relative min-h-screen pt-16">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: safeJsonForHtml(jsonLd) }} />
      <section className={cn(MARKETING_CONTAINER, 'pt-24 pb-24 md:pt-30')}>
        {/* Two-tone title, as in the landing How it works heading. */}
        <h1 className="text-foreground text-xl font-medium tracking-tight text-balance md:text-2xl lg:text-3xl">
          {TITLE}{' '}
          <span className="text-muted-foreground block">Field notes on agents that do real work.</span>
        </h1>

        {lead ? (
          <>
            <div className="mt-16 lg:mt-24">
              <BlogFeaturedPost post={lead} />
            </div>
            {rest.length > 0 ? (
              <div className="mt-16 grid grid-cols-1 gap-x-6 gap-y-16 border-t pt-16 sm:grid-cols-2 lg:mt-24 lg:grid-cols-3 lg:pt-24">
                {rest.map((post) => (
                  <PostCard
                    key={post.slug}
                    post={post}
                    cover={
                      <BlogCover
                        logos={post.data.coverLogos ?? []}
                        withKortix={post.data.coverKortix ?? true}
                        className="aspect-video w-full"
                      />
                    }
                  />
                ))}
              </div>
            ) : null}
          </>
        ) : (
          <div className="mt-16">
            <EmptyState
              title={tI18nHardcoded.raw('autoAppPublicSeoBlogPageJsxAttrTitleNoPosts340caa81')}
              description={tI18nHardcoded.raw('autoAppPublicSeoBlogPageJsxAttrDescriptionWeRecebec139')}
            />
          </div>
        )}
      </section>
    </main>
  );
}
