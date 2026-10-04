import { describe, expect, test } from 'bun:test';
import { displayCompanyLabel } from './marketplace-company-filter';

describe('displayCompanyLabel', () => {
  test.each([
    ['kortix', undefined, 'Dosco'],
    ['anthropics/skills', undefined, 'Anthropic Skills'],
    ['anthropics/knowledge-work-plugins', undefined, 'Anthropic Knowledge Work'],
    ['synthetic/catalog', undefined, 'synthetic/catalog'],
    ['kortix', 'Custom catalog', 'Custom catalog'],
    ['kortix', 'kortix', 'Dosco'],
    ['kortix', '', 'Dosco'],
    ['synthetic/catalog', 'synthetic/catalog', 'synthetic/catalog'],
  ])('%s with label %s returns %s', (id, label, expected) => {
    expect(displayCompanyLabel(id, label)).toBe(expected);
  });
});
