import { describe, expect, mock, test } from 'bun:test';

mock.module('server-only', () => ({}));

const { parsePost } = await import('./blog-posts');

describe('parsePost', () => {
  test('reads every frontmatter field and splits off the body', () => {
    const source = [
      '---',
      'title: "A post"',
      'description: "What it says"',
      'date: "2026-10-25"',
      'updated: "2026-11-01"',
      'canonical: "https://kortix.com/blog/a-post"',
      'author: "marko"',
      'tags: ["Field notes", "Pricing"]',
      'cover: "/blog/a-post.png"',
      'coverLogos:',
      '  - { domain: "example.com", name: "Example" }',
      'coverKortix: true',
      'leadMedia:',
      '  poster: "/p.jpg"',
      '  sources: [{ src: "/v.mp4", type: "video/mp4" }]',
      '  alt: "A clip"',
      '  aspectRatio: "16/9"',
      'lead: "The **opening** line."',
      'readingTime: 7',
      'draft: true',
      '---',
      '',
      'The body.',
      '',
    ].join('\n');

    expect(parsePost('a-post', source)).toEqual({
      slug: 'a-post',
      title: 'A post',
      description: 'What it says',
      date: '2026-10-25',
      updated: '2026-11-01',
      canonical: 'https://kortix.com/blog/a-post',
      author: 'marko',
      tags: ['Field notes', 'Pricing'],
      cover: '/blog/a-post.png',
      coverLogos: [{ domain: 'example.com', name: 'Example' }],
      coverKortix: true,
      leadMedia: { poster: '/p.jpg', sources: [{ src: '/v.mp4', type: 'video/mp4' }], alt: 'A clip', aspectRatio: '16/9' },
      lead: 'The **opening** line.',
      readingTime: 7,
      draft: true,
      body: 'The body.',
    });
  });

  test('defaults the optional fields and turns unquoted YAML dates into ISO days', () => {
    const post = parsePost('dated', '---\ntitle: Dated\ndate: 2026-10-25\nupdated: 2026-11-02\n---\nBody');
    expect(post).toEqual({
      slug: 'dated',
      title: 'Dated',
      description: '',
      date: '2026-10-25',
      updated: '2026-11-02',
      canonical: undefined,
      author: 'team',
      tags: [],
      cover: undefined,
      coverLogos: undefined,
      coverKortix: undefined,
      leadMedia: undefined,
      lead: undefined,
      readingTime: 1,
      draft: false,
      body: 'Body',
    });
  });

  test('counts the lead and the body at 230 words a minute when readingTime is absent', () => {
    const words = (n: number) => Array.from({ length: n }, () => 'word').join(' ');
    expect(parsePost('long', `---\ntitle: Long\ndate: "2026-01-01"\nlead: "${words(115)}"\n---\n${words(575)}`).readingTime).toBe(3);
  });

  test('accepts CRLF fences', () => {
    const post = parsePost('crlf', '---\r\ntitle: CRLF\r\ndate: "2026-01-01"\r\n---\r\nBody\r\n');
    expect(post.title).toBe('CRLF');
    expect(post.body).toBe('Body');
  });

  test('a source with no frontmatter is all body, with the defaults', () => {
    const post = parsePost('bare', '  Just text.  ');
    expect(post.body).toBe('Just text.');
    expect(post.title).toBeUndefined();
    expect(post.date).toBe('undefined');
    expect(post.author).toBe('team');
    expect(post.tags).toEqual([]);
    expect(post.draft).toBe(false);
  });
});
