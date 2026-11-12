import Link from '@/components/site-link';

import { BlogCover } from '@/components/blog/blog-cover';
import { PostMeta } from '@/components/blog/post-card';
import type { Post } from '@/lib/blog';

/**
 * The newest post (Polar blog lead): the two-tone title on the left, the
 * headline in ink and the description under it in muted ink at the same size,
 * the cover on the right. The whole block is one link.
 */
export function BlogFeaturedPost({ post }: { post: Post }) {
  return (
    <article>
      <Link
        href={post.url}
        className="group outline-ring grid grid-cols-1 items-center gap-10 rounded-sm focus-visible:outline-2 focus-visible:outline-offset-4 lg:grid-cols-2 lg:gap-16"
      >
        <div className="order-last lg:order-first">
          <h2 className="text-xl font-medium tracking-tight text-balance md:text-2xl">
            <span className="text-foreground">
              {post.data.title}
            </span>
            {post.data.description ? (
              <>
                {' '}
                <span className="text-muted-foreground mt-2 block line-clamp-3">{post.data.description}</span>
              </>
            ) : null}
          </h2>
          <PostMeta post={post} className="mt-8" />
        </div>
        <BlogCover
          logos={post.data.coverLogos ?? []}
          withKortix={post.data.coverKortix ?? true}
          className="aspect-video w-full"
        />
      </Link>
    </article>
  );
}
