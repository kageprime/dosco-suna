import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';

/**
 * The bulk-theirs of the 4th upstream sync reverted agent-page.tsx's
 * displayAgentName call sites to raw capitalizeWords (rendering "Kortix")
 * with no test to stop it. Pin the mapping at the source level: every
 * rendered agent name on this page goes through displayAgentName.
 */
const page = readFileSync(join(__dirname, 'agent-page.tsx'), 'utf8');
const listPage = readFileSync(join(__dirname, 'agents-page.tsx'), 'utf8');

describe('agent-page display mapping', () => {
  test('renders agent names via displayAgentName, never raw capitalizeWords', () => {
    expect(page).toContain('displayAgentName(agent.name)');
    expect(page).not.toMatch(/capitalizeWords\(agent\.name\)/);
    expect(page).not.toMatch(/capitalizeWords\(result\.default_agent\)/);
  });

  test('agents list page maps titles through displayAgentName too', () => {
    expect(listPage).toContain('displayAgentName(agent.name)');
    expect(listPage).not.toMatch(/capitalizeWords\(agent\.name\)/);
    expect(listPage).not.toMatch(/capitalizeWords\(result\.default_agent\)/);
  });
});
