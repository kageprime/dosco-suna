/**
 * Characterization tests for the shared post card: the rendered markup of the
 * blog and use-case grid cards (cover slot, title, `tag · date` row). The
 * blog assertions pin the markup the pre-dedupe `BlogPostCard` rendered; the
 * use-case assertions pin the unified markup (the card gained the article
 * wrapper, the `group` class and the capitalized tag row that /blog had).
 */
import { expect, mock, test } from 'bun:test';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

mock.module('@/i18n/use-translations', () => ({
  useTranslations: () => Object.assign((key: string) => key, { raw: (key: string) => key }),
}));

const { PostCard } = await import('./post-card');
const { BlogCover } = await import('./blog-cover');
const { UseCaseCover } = await import('@/components/use-cases/use-case-card');
import type { Post } from '@/lib/blog';

const post: Post = {
  slug: 'test-post',
  url: '/blog/test-post',
  data: {
    title: 'A test post',
    description: 'Its description',
    date: '2026-10-25',
    author: 'team',
    tags: ['Field notes'],
    draft: false,
  },
  author: { name: 'The Kortix Team', role: 'Kortix', email: 'team@kortix.ai' },
  readingTime: 4,
};

/** Renders one card and returns its static HTML. */
function markup(element: ReactElement): string {
  return renderToStaticMarkup(element);
}

test('the blog card renders article > link > cover, title, tag · date', () => {
  const html = markup(
    <PostCard
      post={post}
      cover={
        <BlogCover
          logos={post.data.coverLogos ?? []}
          withKortix={post.data.coverKortix ?? true}
          className="aspect-video w-full"
        />
      }
    />,
  );
  expect(html).toContain('<article>');
  expect(html).toContain(
    '<a class="group outline-ring flex flex-col rounded-sm focus-visible:outline-2 focus-visible:outline-offset-4" href="/blog/test-post">',
  );
  expect(html).toContain(
    '<h3 class="text-foreground mt-5 text-base font-medium text-pretty">A test post</h3>',
  );
  expect(html).toContain(
    '<p class="text-muted-foreground flex items-center gap-2 text-sm mt-2"><span class="capitalize">Field notes</span><span aria-hidden="true">·</span><time dateTime="2026-10-25">October 25, 2026</time></p>',
  );
});

test('the use-case card renders article > link > cover, title, tag · date', () => {
  const html = markup(
    <PostCard post={post} cover={<UseCaseCover post={post} className="aspect-video w-full shrink-0" />} />,
  );
  expect(html).toContain('<article>');
  expect(html).toContain(
    '<a class="group outline-ring flex flex-col rounded-sm focus-visible:outline-2 focus-visible:outline-offset-4" href="/blog/test-post">',
  );
  expect(html).toContain(
    '<h3 class="text-foreground mt-5 text-base font-medium text-pretty">A test post</h3>',
  );
  expect(html).toContain(
    '<p class="text-muted-foreground flex items-center gap-2 text-sm mt-2"><span class="capitalize">Field notes</span><span aria-hidden="true">·</span><time dateTime="2026-10-25">October 25, 2026</time></p>',
  );
});

test('the cover renders first inside the link', () => {
  const html = markup(
    <PostCard post={post} cover={<div data-testid="cover-slot" />} />,
  );
  const link = html.slice(html.indexOf('<a '), html.indexOf('</a>'));
  expect(link.indexOf('data-testid="cover-slot"')).toBeLessThan(link.indexOf('<h3'));
});

test('a card without a tag renders the date alone', () => {
  const untagged: Post = { ...post, data: { ...post.data, tags: [] } };
  const html = markup(
    <PostCard
      post={untagged}
      cover={<BlogCover logos={[]} withKortix className="aspect-video w-full" />}
    />,
  );
  expect(html).not.toContain('capitalize');
  expect(html).toContain(
    '<p class="text-muted-foreground flex items-center gap-2 text-sm mt-2"><time dateTime="2026-10-25">October 25, 2026</time></p>',
  );
});
