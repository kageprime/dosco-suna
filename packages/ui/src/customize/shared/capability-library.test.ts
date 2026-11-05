import { describe, expect, test } from 'bun:test';
import type { AgentCapabilityGrant } from '@kortix/sdk';

import { capabilityModeGrant, catalogRows } from './capability-library';

const IDS = ['kortix-system', 'kortix-genui', 'pdf'];

function drive(value: AgentCapabilityGrant | undefined) {
  let written: AgentCapabilityGrant | undefined;
  const grant = capabilityModeGrant(value, IDS, 'none', (next) => {
    written = next;
  });
  return { grant, written: () => written };
}

describe('capabilityModeGrant', () => {
  test('{ exclude } reads as All, with the excluded row off', () => {
    const { grant } = drive({ exclude: ['kortix-genui'] });
    expect(grant.mode).toBe('all');
    expect(grant.isGranted('kortix-system')).toBe(true);
    expect(grant.isGranted('kortix-genui')).toBe(false);
  });

  test('Specific keeps every row that is on, built-ins included', () => {
    const run = drive({ exclude: ['kortix-genui'] });
    run.grant.setMode('specific');
    expect(run.written()).toEqual(['kortix-system', 'pdf']);
  });

  test('Specific from None with nothing on stays None', () => {
    const run = drive(undefined);
    expect(run.grant.mode).toBe('none');
    run.grant.setMode('specific');
    expect(run.written()).toBe('none');
  });

  test('one row off under All writes the exclude form', () => {
    const run = drive('all');
    run.grant.toggle('kortix-system');
    expect(run.written()).toEqual({ exclude: ['kortix-system'] });
  });
});

describe('catalogRows un-prefixes and brand-sanitizes', () => {
  const mockT = ((key: string) => key) as any;

  test('strips kortix- prefix and replaces Kortix in skill description', () => {
    const catalog: any = {
      skills: [
        {
          id: 'kortix-apps',
          group: 'builtin',
          available: true,
          description: 'Build, deploy and operate Kortix Apps',
        },
        {
          id: 'custom-skill',
          group: 'project',
          available: true,
          description: 'Project specific skill',
        },
      ],
      tools: [],
      extensions: [],
    };

    const res = catalogRows('skills', catalog, mockT, false);
    expect(res.builtin).toHaveLength(1);
    expect(res.builtin[0].id).toBe('kortix-apps');
    // ReactNode title contains cleanTitle "apps"
    expect((res.builtin[0].title as any).props.children).toBe('apps');
    expect(res.builtin[0].description).toBe('Build, deploy and operate Dosco Apps');

    expect(res.project).toHaveLength(1);
    expect(res.project[0].id).toBe('custom-skill');
    expect((res.project[0].title as any).props.children).toBe('custom-skill');
  });

  test('strips kortix- prefix and replaces Kortix in extension description', () => {
    const catalog: any = {
      skills: [],
      tools: [],
      extensions: [
        {
          id: 'kortix-ext',
          group: 'platform',
          description: 'A Kortix extension',
          required: false,
        },
      ],
    };

    const res = catalogRows('extensions', catalog, mockT, false);
    expect(res.builtin).toHaveLength(1);
    expect(res.builtin[0].id).toBe('kortix-ext');
    expect((res.builtin[0].title as any).props.children).toBe('ext');
    expect(res.builtin[0].description).toBe('A Dosco extension');
  });
});
