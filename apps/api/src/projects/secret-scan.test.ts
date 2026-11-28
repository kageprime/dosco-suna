import { describe, expect, test } from 'bun:test';
import { describeSecretFindings, MAX_SECRET_FINDINGS, scanAddedLines, secretRulesInLine } from './secret-scan';

// Every token below is synthetic and assembled at runtime, so this file never
// carries a literal a secret scanner (gitleaks, GitHub push protection) flags.
const body = (length: number, alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789') =>
  Array.from({ length }, (_, i) => alphabet[(i * 7919 + 17) % alphabet.length]).join('');
const join = (...parts: string[]) => parts.join('');
const TOKENS: Record<string, string> = {
  private_key: join('-----BEGIN ', 'RSA PRIVATE KEY-----'),
  anthropic_api_key: join('sk-', 'ant-api03-', body(93)),
  openai_api_key: join('sk-', body(48)),
  openai_project_key: join('sk-', 'proj-', body(120, 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-')),
  github_token: join('gh', 'p_', body(36)),
  github_pat: join('github', '_pat_', body(22), '_', body(59)),
  aws_access_key_id: join('AK', 'IA', body(16, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567')),
  slack_token: join('xo', 'xb-', '123456789012-', body(24)),
  google_api_key: join('AI', 'za', body(35)),
  stripe_live_key: join('sk', '_live_', body(24)),
};
const ruleOf = (token: string) => secretRulesInLine(`const value = "${token}";`).map((rule) => rule.id);

describe('secretRulesInLine — provider-prefixed formats only', () => {
  test('each supported format is found by its rule', () => {
    expect(ruleOf(TOKENS.private_key!)).toEqual(['private_key']);
    expect(ruleOf(TOKENS.anthropic_api_key!)).toEqual(['anthropic_api_key']);
    expect(ruleOf(TOKENS.openai_api_key!)).toEqual(['openai_api_key']);
    expect(ruleOf(TOKENS.openai_project_key!)).toEqual(['openai_api_key']);
    expect(ruleOf(TOKENS.github_token!)).toEqual(['github_token']);
    expect(ruleOf(TOKENS.github_pat!)).toEqual(['github_token']);
    expect(ruleOf(TOKENS.aws_access_key_id!)).toEqual(['aws_access_key_id']);
    expect(ruleOf(TOKENS.slack_token!)).toEqual(['slack_token']);
    expect(ruleOf(TOKENS.google_api_key!)).toEqual(['google_api_key']);
    expect(ruleOf(TOKENS.stripe_live_key!)).toEqual(['stripe_live_key']);
  });

  test('a token inside a header, a URL or YAML is found', () => {
    expect(secretRulesInLine(`      Authorization: Bearer ${TOKENS.github_token}`).map((r) => r.id)).toEqual(['github_token']);
    expect(secretRulesInLine(`https://x.test/?key=${TOKENS.google_api_key}&q=1`).map((r) => r.id)).toEqual(['google_api_key']);
  });

  test('documented placeholders and look-alikes are not findings', () => {
    for (const text of [
      join('AK', 'IAIOSFODNN7', 'EXAMPLE'), // the AWS documentation key
      join('gh', 'p_', 'x'.repeat(36)),
      join('sk-', '0'.repeat(48)),
      join('sk-', 'your-key-here'),
      join('sk', '_test_', body(24)), // a Stripe test key is not a live key
      join('gh', 'p_', body(35)), // one character short
      'sk-learn-pipeline-transformer-for-the-examples',
      'BEGIN PUBLIC KEY',
      'const token = process.env.GITHUB_TOKEN;',
    ]) {
      expect({ text, rules: ruleOf(text) }).toEqual({ text, rules: [] });
    }
  });
});

describe('scanAddedLines — what a diff adds, by file and new line number', () => {
  const patch = [
    'diff --git a/src/config.ts b/src/config.ts',
    'new file mode 100644',
    'index 0000000..1111111',
    '--- /dev/null',
    '+++ b/src/config.ts',
    '@@ -0,0 +1,3 @@',
    '+// config',
    `+export const GITHUB_TOKEN = '${TOKENS.github_token}';`,
    '+export const region = "eu";',
    'diff --git a/kortix.yaml b/kortix.yaml',
    'index 2222222..3333333 100644',
    '--- a/kortix.yaml',
    '+++ b/kortix.yaml',
    '@@ -10,0 +11,2 @@ connectors:',
    '+    headers:',
    `+      Authorization: Bearer ${TOKENS.openai_api_key}`,
    '@@ -20 +22 @@',
    `-    key: ${TOKENS.stripe_live_key}`,
    '+    key: ${STRIPE_KEY}',
    'diff --git a/logo.png b/logo.png',
    'Binary files a/logo.png and b/logo.png differ',
    '',
  ].join('\n');

  test('names file, new line number and rule; a removed key is not a finding', () => {
    const scan = scanAddedLines(patch);
    expect(scan.total).toBe(2);
    expect(scan.findings).toEqual([
      { file: 'src/config.ts', line: 2, rule: 'github_token', label: 'GitHub token' },
      { file: 'kortix.yaml', line: 12, rule: 'openai_api_key', label: 'OpenAI-style API key' },
    ]);
  });

  test('no finding carries the value', () => {
    const serialized = JSON.stringify(scanAddedLines(patch));
    expect(serialized).not.toContain(TOKENS.github_token!);
    expect(serialized).not.toContain(TOKENS.github_token!.slice(0, 12));
    expect(serialized).not.toContain(TOKENS.openai_api_key!.slice(0, 12));
  });

  test('an added line that starts with "++" is hunk content, not a file header', () => {
    const tricky = [
      'diff --git a/a.c b/a.c',
      '--- a/a.c',
      '+++ b/a.c',
      '@@ -1,0 +1,2 @@',
      '+++ b/elsewhere.c',
      `+char *k = "${TOKENS.aws_access_key_id}";`,
      '',
    ].join('\n');
    expect(scanAddedLines(tricky).findings).toEqual([
      { file: 'a.c', line: 2, rule: 'aws_access_key_id', label: 'AWS access key ID' },
    ]);
  });

  test('a C-quoted path is unquoted; a deleted file adds nothing', () => {
    const quoted = [
      'diff --git "a/dir/caf\\303\\251 \\"x\\".env" "b/dir/caf\\303\\251 \\"x\\".env"',
      '--- /dev/null',
      '+++ "b/dir/caf\\303\\251 \\"x\\".env"',
      '@@ -0,0 +1 @@',
      `+SLACK=${TOKENS.slack_token}`,
      'diff --git a/old.env b/old.env',
      'deleted file mode 100644',
      '--- a/old.env',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      `-SLACK=${TOKENS.slack_token}`,
      '',
    ].join('\n');
    expect(scanAddedLines(quoted).findings).toEqual([
      { file: 'dir/café "x".env', line: 1, rule: 'slack_token', label: 'Slack token' },
    ]);
  });

  test('a control character in a quoted path stays escaped: no terminal escape reaches a reply', () => {
    const patch = [
      'diff --git "a/x\\033[2Jy.ts" "b/x\\033[2Jy.ts"',
      '--- /dev/null',
      '+++ "b/x\\033[2Jy.ts"',
      '@@ -0,0 +1 @@',
      `+${TOKENS.github_token}`,
      '',
    ].join('\n');
    const [finding] = scanAddedLines(patch).findings;
    expect(finding?.file).toBe('x\\u001b[2Jy.ts');
    expect(finding?.file).not.toContain('\u001b');
  });

  test('a C1 or bidirectional mark in an unquoted path is escaped too', () => {
    const patch = ['diff --git a/x b/x', '--- /dev/null', '+++ b/a\u202egnp.ts\u0085', '@@ -0,0 +1 @@', `+${TOKENS.github_token}`, ''].join('\n');
    expect(scanAddedLines(patch).findings[0]?.file).toBe('a\\u202egnp.ts\\u0085');
  });

  test('findings are capped; the total still counts every one', () => {
    const many = ['diff --git a/k b/k', '--- a/k', '+++ b/k', `@@ -0,0 +1,${MAX_SECRET_FINDINGS + 7} @@`];
    for (let i = 0; i < MAX_SECRET_FINDINGS + 7; i += 1) many.push(`+${TOKENS.github_token}`);
    const scan = scanAddedLines(`${many.join('\n')}\n`);
    expect(scan.findings).toHaveLength(MAX_SECRET_FINDINGS);
    expect(scan.total).toBe(MAX_SECRET_FINDINGS + 7);
    expect(describeSecretFindings(scan, 2)).toBe(`k:1 (GitHub token), k:2 (GitHub token) and ${MAX_SECRET_FINDINGS + 5} more`);
  });
});
