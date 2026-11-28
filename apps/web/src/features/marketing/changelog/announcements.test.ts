import { expect, test } from 'bun:test';
import { parseAnnouncements } from './announcements';

const entry = {
  title: 'Synthetic launch',
  text: 'A new capability.',
  cover: {
    url: 'https://ke4pydspzeg0nm0o.public.blob.vercel-storage.com/changelog/test.png',
    alt: 'Synthetic cover',
    width: 1200,
    height: 630,
  },
  guide_url: 'https://kortix.com/docs',
  tags: ['v0.16.0'],
};
test('legacy and malformed input has no announcements', () => {
  for (const value of [undefined, null, {}, 'bad', [null, false, 42]])
    expect(parseAnnouncements(value)).toEqual([]);
});
test('approved payload preserves text, dimensions, guide and release tags', () => {
  expect(parseAnnouncements([entry])).toEqual([
    {
      title: entry.title,
      text: entry.text,
      media: { cover: entry.cover },
      guideUrl: entry.guide_url,
      tags: entry.tags,
    },
  ]);
});
test('omits unsafe media, links and malformed entries without losing valid siblings', () => {
  for (const bad of [
    { ...entry, cover: { ...entry.cover, url: 'https://evil.test/cover.png' } },
    { ...entry, cover: { ...entry.cover, alt: '' } },
    { ...entry, cover: { ...entry.cover, width: 0 } },
    { ...entry, guide_url: 'javascript:alert(1)' },
    { ...entry, guide_url: 'https://user:password@kortix.com/docs' },
    { ...entry, text: 'x'.repeat(281) },
    { ...entry, tags: ['javascript:alert(1)'] },
  ])
    expect(parseAnnouncements([bad, entry])).toHaveLength(1);
});
test('280 Unicode characters are valid; unsafe optional video is omitted', () => {
  expect(
    parseAnnouncements([{ ...entry, text: '🚀'.repeat(280), video_url: 'javascript:alert(1)' }])[0]
      ?.media,
  ).toEqual({ cover: entry.cover });
});
test('only first-party motion files use the optional video surface', () => {
  const video_url = 'https://ke4pydspzeg0nm0o.public.blob.vercel-storage.com/changelog/demo.mp4';
  expect(parseAnnouncements([{ ...entry, video_url }])[0]?.media.videoUrl).toBe(video_url);
  expect(
    parseAnnouncements([{ ...entry, video_url: 'https://evil.test/demo.mp4' }])[0]?.media.videoUrl,
  ).toBeUndefined();
});
