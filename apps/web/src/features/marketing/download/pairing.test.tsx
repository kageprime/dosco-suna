import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { DownloadOptions } from './download-options';

for (const detected of ['macos', 'android'] as const) {
  test(`${detected} visitors see the Android APK download option and web app link`, () => {
    const html = renderToStaticMarkup(<DownloadOptions detected={detected} />);
    expect(html).toContain('href="/download/android"');
    expect(html).toContain('APK · direct download');
    expect(html).toContain('open the web app');
  });
}
