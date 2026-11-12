import { describe, expect, mock, test } from 'bun:test';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { IntlTestProvider } from '../../../test-utils/intl';

/** The viewer under the renderer is stubbed: the renderer's contract is what
 *  it hands the viewer (the workbook bytes it was given, never a path to
 *  read) and the error card it draws when the parent has no bytes. */
const seenProps: Array<{ workbook?: Blob | null; fileName?: string }> = [];

mock.module('./xlsx-viewer', () => ({
  XlsxViewerPreview: (props: { workbook?: Blob | null; fileName?: string }) => {
    seenProps.push(props);
    return <div data-testid="stub-xlsx-viewer" />;
  },
}));

const { XlsxRenderer } = await import('./xlsx-renderer');

function render(node: ReactNode) {
  return renderToStaticMarkup(
    <IntlTestProvider locale="en" onError={() => {}}>
      {node}
    </IntlTestProvider>,
  );
}

describe('XlsxRenderer', () => {
  test('renders the workbook from the blob the parent passed, with its name', () => {
    seenProps.length = 0;
    const blob = new Blob([new Uint8Array([1, 2, 3])]);
    const html = render(<XlsxRenderer blob={blob} fileName="report.xlsx" />);
    expect(html).toContain('stub-xlsx-viewer');
    expect(seenProps).toHaveLength(1);
    expect(seenProps[0].workbook).toBe(blob);
    expect(seenProps[0].fileName).toBe('report.xlsx');
  });

  test('renders the error card when the parent has no bytes', () => {
    const html = render(<XlsxRenderer blob={null} fileName="report.xlsx" />);
    expect(html).not.toContain('stub-xlsx-viewer');
    expect(html).toContain('Failed to load spreadsheet');
  });
});
