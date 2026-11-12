import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Post } from '@/lib/blog';
import { UseCaseCover } from './use-case-card';

const post: Post = {
  slug: 'synthetic-workflow', url: '/use-cases/synthetic-workflow',
  data: { title: 'Synthetic workflow', date: '2026-10-25', author: 'team', tags: ['Operations'], draft: false },
  author: { name: 'Synthetic author', role: 'Test', email: 'agent@kortix.ai' }, readingTime: 2,
};

describe('UseCaseCover live renderer', () => {
  it('keeps the fallback tile when the slug has no custom cover and the frontmatter has no image', () => {
    const markup = renderToStaticMarkup(<UseCaseCover post={post} />);
    expect(markup).toContain('animate-kortix-bullet-flow');
    expect(markup).not.toContain('<img');
  });

  it('uses a frontmatter cover instead of the fallback', () => {
    const markup = renderToStaticMarkup(<UseCaseCover post={{ ...post, data: { ...post.data, cover: '/synthetic-cover.png' } }} />);
    expect(markup).toContain('<img');
    expect(markup).toContain('alt="Synthetic workflow"');
    expect(markup).toContain('synthetic-cover.png');
  });
});
