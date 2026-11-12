'use client';

import Image from 'next/image';

import { KortixAsterisk } from '@kortix/ui/kortix-asterisk';
import { type Post } from '@/lib/blog';
import { cn } from '@kortix/ui';
import { USE_CASE_COVERS } from './covers';

/**
 * Cover art with three tiers, most specific first:
 *  1. a custom per-slug cover component (USE_CASE_COVERS) — put anything here;
 *  2. the frontmatter `cover` image;
 *  3. a plain muted tile with the asterisk.
 */
export function UseCaseCover({
  post,
  featured,
  className,
}: {
  post: Post;
  featured?: boolean;
  className?: string;
}) {
  const Custom = USE_CASE_COVERS[post.slug];
  if (Custom) {
    return (
      <div className={cn('bg-muted border-border relative overflow-hidden border', className)}>
        <Custom post={post} featured={featured} />
      </div>
    );
  }
  if (post.data.cover) {
    return (
      <div className={cn('bg-muted border-border relative overflow-hidden border', className)}>
        <Image
          src={post.data.cover}
          alt={post.data.title}
          fill
          className="object-cover"
          sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw"
        />
      </div>
    );
  }
  return (
    <div className={cn('bg-muted border-border relative flex items-center justify-center border', className)}>
      <KortixAsterisk index={0} parentClass="size-10" />
    </div>
  );
}
