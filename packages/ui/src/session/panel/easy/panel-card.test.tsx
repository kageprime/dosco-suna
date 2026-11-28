import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { PanelCard } from './panel-card';

describe('PanelCard', () => {
  test('renders the header action beside the title', () => {
    const html = renderToStaticMarkup(
      <PanelCard
        title="Outputs"
        isEmpty={false}
        headerAction={<button type="button" aria-label="Download all" />}
      >
        <div>body</div>
      </PanelCard>,
    );
    expect(html).toContain('aria-label="Download all"');
    expect(html).toContain('>body<');
  });

  test('an empty section shows its sentence, not its children', () => {
    const html = renderToStaticMarkup(
      <PanelCard title="Outputs" isEmpty emptyText="Files show up here.">
        <div>body</div>
      </PanelCard>,
    );
    expect(html).toContain('Files show up here.');
    expect(html).not.toContain('>body<');
  });
});
