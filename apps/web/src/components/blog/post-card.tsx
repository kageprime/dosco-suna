import Link from '@/components/site-link';

import { formatPostDate, type Post } from '@/lib/blog';
import { cn } from '@kortix/ui';
import type { ReactNode } from 'react';

/** "Field notes · October 25, 2026": the first tag and the date, muted. */
export function PostMeta({ post, className }: { post: Post; className?: string }) {
  const tag = post.data.tags[0];
  return (
    <p className={cn('text-muted-foreground flex items-center gap-2 text-sm', className)}>
      {tag ? (
        <>
          <span className="capitalize">{tag}</span>
          <span aria-hidden>·</span>
        </>
      ) : null}
      <time dateTime={post.data.date}>{formatPostDate(post.data.date)}</time>
    </p>
  );
}

/** A post in the grid (Polar blog card): a wide cover, the title, then tag and date. */
export function PostCard({ post, cover }: { post: Post; cover: ReactNode }) {
  return (
    <article>
      <Link
        href={post.url}
        className="group outline-ring flex flex-col rounded-sm focus-visible:outline-2 focus-visible:outline-offset-4"
      >
        {cover}
        <h3 className="text-foreground mt-5 text-base font-medium text-pretty">
          {post.data.title}
        </h3>
        <PostMeta post={post} className="mt-2" />
      </Link>
    </article>
  );
}
