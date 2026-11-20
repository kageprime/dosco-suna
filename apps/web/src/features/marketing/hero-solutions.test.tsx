import { describe, expect, mock, test } from 'bun:test';
import type { ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// The hero reads the demo-dialog opener but never renders the dialog in this
// test; the real provider would pull the whole qualifier modal into the module
// graph.
mock.module('@/features/contact/request-demo-provider', () => ({
  useRequestDemo: () => () => {},
}));

const { default: Hero, RivalEyebrow } = await import('./hero');
const { ComplianceHero } = await import('./compliance/compliance-hero');
const { EnterpriseHero } = await import('./enterprise/enterprise-hero');
const { FrameworkHero } = await import('./framework/framework-hero');
const { MultiplayerHero } = await import('./multiplayer/multiplayer-hero');
const { SecurityHero } = await import('./security-page/security-hero');
const { SovereignHero } = await import('./sovereign/sovereign-hero');

// The prop type is the literal-narrowed shipped English content. These tests
// feed synthetic content, so the fixture is widened here once.
type EyebrowContent = ComponentProps<typeof RivalEyebrow>['content'];
const eyebrow = (content: { lead: string; rivals: readonly { id: string; icon: string; label: string }[] }) =>
  content as unknown as EyebrowContent;

describe('hero characterization', () => {
  test('Hero renders its shipped fold with the walkthrough band and both CTAs', () => {
    const html = renderToStaticMarkup(<Hero />);
    expect(html).toContain('id="hero"');
    expect(html).toContain('id="demo"');
    expect(html).toContain('The production harness');
    expect(html).toContain('for autonomous agent teams.');
    expect(html).toContain('Give AI agents persistent workstations, real cloud computers');
    expect(html).toContain('Any model, your keys · Isolated cloud sandboxes · Governed review');
    expect(html).toContain('Talk to sales');
    expect(html).toContain('Start for free');
  });

  test('RivalEyebrow renders both supported logos and the separator', () => {
    expect(renderToStaticMarkup(<RivalEyebrow content={eyebrow({
      lead: 'Compare with',
      rivals: [
        { id: 'claude', icon: 'Claude', label: 'Claude' },
        { id: 'openai', icon: 'OpenAI', label: 'OpenAI' },
      ],
    })} />)).toMatchSnapshot();
  });

  test('RivalEyebrow renders an empty rival list', () => {
    expect(renderToStaticMarkup(<RivalEyebrow content={eyebrow({ lead: 'Compare with', rivals: [] })} />)).toMatchSnapshot();
  });

  test('RivalEyebrow retains a label when its icon is unknown', () => {
    const html = renderToStaticMarkup(<RivalEyebrow content={eyebrow({
      lead: 'Compare with',
      rivals: [{ id: 'synthetic', icon: 'Unknown', label: 'Synthetic rival' }],
    })} />);
    expect(html).toMatchSnapshot();
    expect(html).toContain('Synthetic rival');
    expect(html).not.toContain('<svg');
  });
});

describe('solution page hero characterization', () => {
  const heroes = [
    ['compliance', ComplianceHero],
    ['enterprise', EnterpriseHero],
    ['framework', FrameworkHero],
    ['multiplayer', MultiplayerHero],
    ['security', SecurityHero],
    ['sovereign', SovereignHero],
  ] as const;

  for (const [name, SolutionHero] of heroes) {
    test(`${name} hero renders its shipped fold and first walkthrough step`, () => {
      expect(renderToStaticMarkup(<SolutionHero />)).toMatchSnapshot();
    });
  }
});
