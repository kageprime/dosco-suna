import { describe, expect, test } from 'bun:test';

import { parseProjectAdminSection } from '../../customize/project-settings/project-admin-sections';

import { SETTINGS_SEARCH_ENTRIES, searchSettings, settingsSearchHref, type SettingsSearchSection } from './settings-search';

const base = '/workspaces/p1/admin';
const section = (key: string, label: string): SettingsSearchSection => ({ key, label, href: `${base}/${key}` });
const ALL: SettingsSearchSection[] = [
  section('general', 'General'),
  section('security', 'Security'),
  section('api-keys', 'API keys'),
  section('models', 'Models'),
  section('connectors', 'Connectors'),
  section('triggers', 'Triggers'),
  section('members', 'Members'),
];

const labels = (query: string, sections = ALL) => searchSettings(query, sections).map((r) => r.label);

describe('searchSettings', () => {
  test('an entry inside a section is found by its own label', () => {
    expect(labels('oauth')[0]).toBe('OAuth apps');
  });

  test('a section row outranks a same-named entry inside it', () => {
    expect(labels('models').slice(0, 2)).toEqual(['Models', 'Models']);
    expect(searchSettings('models', ALL)[0]?.entry).toBeUndefined();
  });

  test('a keyword finds an entry whose label does not contain it', () => {
    expect(labels('custom gateway')).toContain('Custom');
    expect(labels('2fa')).toEqual(['Require two-factor authentication']);
  });

  test('a query that only names a section does not list every entry inside it', () => {
    const shown = searchSettings('model', ALL).map((r) => r.label);
    // Only entries whose own label or keywords say "model" (the Models tab, Routing, …).
    for (const unrelated of ['Budget', 'Logs', 'Costs', 'Providers', 'Custom', 'ChatGPT subscription usage']) {
      expect(shown).not.toContain(unrelated);
    }
  });

  test('a word may name the section while another names the entry', () => {
    expect(labels('models routing')).toEqual(['Routing']);
  });

  test('every word must match', () => {
    expect(labels('oauth routing')).toEqual([]);
  });

  test('a section the caller cannot open hides its entries', () => {
    const withoutApiKeys = ALL.filter((s) => s.key !== 'api-keys');
    expect(labels('oauth', withoutApiKeys)).toEqual([]);
  });

  test('a tab entry carries its query onto the section link', () => {
    const routing = searchSettings('routing', ALL).find((r) => r.entry?.id === 'models-routing');
    expect(routing && settingsSearchHref(routing)).toBe(`${base}/models?tab=routing`);
    const chatgpt = searchSettings('chatgpt', ALL).find((r) => r.entry?.id === 'models-chatgpt-usage');
    expect(chatgpt && settingsSearchHref(chatgpt)).toBe(`${base}/models?tab=providers&provider=openai`);
  });

  test('every entry names a real section and has a unique id', () => {
    const ids = new Set<string>();
    for (const entry of SETTINGS_SEARCH_ENTRIES) {
      expect(parseProjectAdminSection(entry.section)).toBe(entry.section);
      expect(ids.has(entry.id)).toBe(false);
      ids.add(entry.id);
    }
  });
});
