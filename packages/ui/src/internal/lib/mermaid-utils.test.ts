import { describe, expect, test } from 'bun:test';

import { extractMermaidDiagrams, isMermaidCode, validateMermaidSyntax } from './mermaid-utils';

describe('validateMermaidSyntax', () => {
  test('accepts a first line that starts with a diagram type', () => {
    expect(validateMermaidSyntax('graph TD\nA --> B')).toEqual({ valid: true });
    expect(validateMermaidSyntax('erDiagram\n  A ||--o{ B : has')).toEqual({ valid: true });
    expect(validateMermaidSyntax('C4Context\ntitle demo')).toEqual({ valid: true });
  });

  test('accepts a first line that contains a diagram type anywhere', () => {
    expect(validateMermaidSyntax('my sequencediagram demo\nA->>B: hi')).toEqual({ valid: true });
    expect(validateMermaidSyntax('see graph paper\nA --> B')).toEqual({ valid: true });
  });

  test('rejects a source without a diagram type', () => {
    expect(validateMermaidSyntax('hello world')).toEqual({
      valid: false,
      error:
        'Diagram must start with a valid Mermaid diagram type (e.g., graph, flowchart, sequenceDiagram, etc.)',
    });
    // The git command tail belongs to the fence router, not this validator.
    expect(validateMermaidSyntax('commit id: "a1"')).toMatchObject({ valid: false });
    expect(validateMermaidSyntax('branch feature')).toMatchObject({ valid: false });
  });

  test('rejects an empty diagram', () => {
    expect(validateMermaidSyntax('')).toEqual({ valid: false, error: 'Empty diagram' });
    expect(validateMermaidSyntax('   \n  ')).toEqual({ valid: false, error: 'Empty diagram' });
  });
});

describe('extractMermaidDiagrams', () => {
  test('extracts only the fences that route as Mermaid, numbered in order', () => {
    const content = [
      '```mermaid',
      'graph TD',
      'A-->B',
      '```',
      'text',
      '```ts',
      'const a = 1',
      '```',
      '```mermaid',
      'sequenceDiagram',
      'A->>B: hi',
      '```',
    ].join('\n');

    const diagrams = extractMermaidDiagrams(content);

    expect(diagrams).toHaveLength(2);
    expect(diagrams[0]).toMatchObject({ code: 'graph TD\nA-->B', language: 'mermaid', index: 0 });
    expect(diagrams[1]).toMatchObject({
      code: 'sequenceDiagram\nA->>B: hi',
      language: 'mermaid',
      index: 2,
    });
  });

  test('routes an unlabelled fence by its content and labels it mermaid', () => {
    const diagrams = extractMermaidDiagrams('```\nflowchart LR\nA-->B\n```');
    expect(diagrams).toHaveLength(1);
    expect(diagrams[0]).toMatchObject({ code: 'flowchart LR\nA-->B', language: 'mermaid' });
  });

  test('finds nothing in plain prose', () => {
    expect(extractMermaidDiagrams('just text, no fences')).toEqual([]);
  });
});

describe('isMermaidCode re-export', () => {
  test('re-exports the shared fence router unchanged', () => {
    expect(isMermaidCode('mermaid', 'anything')).toBe(true);
    expect(isMermaidCode('', 'graph TD\nA --> B')).toBe(true);
    expect(isMermaidCode('ts', 'graph TD')).toBe(false);
  });
});
