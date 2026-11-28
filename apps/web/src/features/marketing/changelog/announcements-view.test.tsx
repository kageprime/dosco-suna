import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseAnnouncements } from './announcements';
import { AnnouncementsView } from './announcements-view';

test('legacy week adds no markup', () => {
  expect(renderToStaticMarkup(<AnnouncementsView />)).toBe('');
});
test('renders cover, guide, escaped text, video controls and release deep links', () => {
  const announcements = parseAnnouncements([
    {
      title: 'Synthetic <launch>',
      text: 'Use <script> as text.',
      guide_url: 'https://kortix.com/docs',
      tags: ['v0.16.0'],
      cover: {
        url: 'https://ke4pydspzeg0nm0o.public.blob.vercel-storage.com/changelog/test.png',
        alt: 'Launch cover',
        width: 1200,
        height: 630,
      },
      video_url: 'https://ke4pydspzeg0nm0o.public.blob.vercel-storage.com/changelog/demo.mp4',
    },
  ]);
  const html = renderToStaticMarkup(<AnnouncementsView announcements={announcements} />);
  expect(html).toContain('Synthetic &lt;launch&gt;');
  expect(html).toContain('Use &lt;script&gt; as text.');
  expect(html).toContain('alt="Launch cover"');
  expect(html).toContain('width="1200"');
  expect(html).toContain('height="630"');
  expect(html).toContain('href="https://kortix.com/docs"');
  expect(html).toContain('href="/changelog#v0.16.0"');
  expect(html).toContain('<video controls=""');
  expect(html).not.toContain('autoplay');
});

test('the guide action uses the host locale', async () => {
  const { NextIntlClientProvider } = await import('next-intl');
  const announcements = parseAnnouncements([{
    title: 'Synthetic launch', text: 'Synthetic release.', guide_url: 'https://kortix.com/docs', tags: ['v0.16.0'],
    cover: { url: 'https://ke4pydspzeg0nm0o.public.blob.vercel-storage.com/changelog/test.png', alt: 'Synthetic cover', width: 1200, height: 630 },
  }]);
  const html = renderToStaticMarkup(
    <NextIntlClientProvider locale="de" timeZone="UTC" messages={{ hardcodedUi: { i18nComplete: { text83b3b277abbf: 'Anleitung lesen' } } }}>
      <AnnouncementsView announcements={announcements} />
    </NextIntlClientProvider>,
  );
  expect(html).toContain('Anleitung lesen');
  expect(html).not.toContain('Read the guide');
});
