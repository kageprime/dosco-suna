import './tools/register';
import { ToolPartRenderer } from './tool-part-renderer';
import { ToolRegistry } from './shared/registry';
import { renderStatic } from './render-static';
import type { ToolPart } from '../../internal/session-types';
import { toolCallBlock } from '@kortix/sdk';
import { describe, expect, test } from 'bun:test';

const part = (tool: string) => ({
  type: 'tool', tool, callID: 'characterization',
  state: { status: 'completed', input: { command: 'echo dispatch' }, output: 'dispatch-result', metadata: {} },
}) as unknown as ToolPart;

function render(tool: string) {
  return renderStatic(
    <ToolPartRenderer call={toolCallBlock(part(tool))} sessionId="child" defaultOpen />,
  );
}

describe('tool registry dispatch', () => {
  test('registered bash tool renders its command', () => {
    expect(ToolRegistry.get('bash')).toBeDefined();
    // Text only: once Shiki has loaded in this process (another file highlighted code), the
    // command renders as token spans.
    expect(render('bash').text).toContain('echo dispatch');
  });

  test('unknown tool renders the generic fallback', () => {
    expect(ToolRegistry.get('unregistered/characterization')).toBeUndefined();
    expect(render('unregistered/characterization').html).toContain('Characterization');
  });
});
