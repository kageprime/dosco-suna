import { beforeAll, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { DownloadOptions } from './download-options';

beforeAll(() => {
  process.env.SUPABASE_URL = 'http://localhost:54321';
  process.env.SUPABASE_ANON_KEY = 'test-anon-key';
  process.env.BACKEND_URL = 'http://localhost:8008';
});

for (const detected of ['macos', 'android'] as const) {
  test(`${detected} visitors see both desktop and mobile download options`, () => {
    const html = renderToStaticMarkup(<DownloadOptions detected={detected} />);
    expect(html).toContain('href="/download/macos"');
    expect(html).toContain('href="/download/windows"');
    expect(html).toContain('href="/download/linux"');
    expect(html).toContain('href="/download/android"');
    expect(html).toContain('APK · direct download');
  });
}
