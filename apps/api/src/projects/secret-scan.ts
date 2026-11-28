/**
 * High-confidence secret detection for what a change lands on the default
 * branch: the lines a change request adds, and the lines an agent session
 * pushes straight to the default branch.
 *
 * Provider-prefixed formats only. There is no generic entropy rule, so a hit
 * is almost always a real credential and a merge that is refused is refused
 * for a reason a person agrees with. A key that matches none of these rules
 * passes: this is a guard against the common accident (a key pasted into
 * code or `kortix.yaml`), not a complete scanner.
 *
 * A finding names the file, the line and the rule. It never carries the
 * value, not even a prefix: findings go into API responses, logs and the
 * change request's metadata.
 */

export interface SecretRule {
  /** Stable id, returned to clients. */
  id: string;
  /** What the rule finds, for a person. */
  label: string;
  pattern: RegExp;
  /** PEM headers are fixed text: the placeholder filter does not apply. */
  fixedText?: boolean;
}

export const SECRET_RULES: readonly SecretRule[] = [
  {
    id: 'private_key',
    label: 'private key',
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/g,
    fixedText: true,
  },
  { id: 'anthropic_api_key', label: 'Anthropic API key', pattern: /\bsk-ant-[a-z]{2,8}\d{2}-[A-Za-z0-9_-]{32,}/g },
  // `sk-proj-…`, `sk-svcacct-…`, `sk-admin-…`, and the legacy `sk-` + 32 or more
  // letters and digits. `sk-ant-` never matches here: its `-` ends the run.
  {
    id: 'openai_api_key',
    label: 'OpenAI-style API key',
    pattern: /\bsk-(?:(?:proj|svcacct|admin)-[A-Za-z0-9_-]{40,}|[A-Za-z0-9]{32,}\b)/g,
  },
  {
    id: 'github_token',
    label: 'GitHub token',
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36}\b|github_pat_[A-Za-z0-9]{22}_[A-Za-z0-9]{59}\b)/g,
  },
  { id: 'aws_access_key_id', label: 'AWS access key ID', pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { id: 'slack_token', label: 'Slack token', pattern: /\bxox[abprs]-\d{6,}-[A-Za-z0-9-]{8,}/g },
  { id: 'google_api_key', label: 'Google API key', pattern: /\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/g },
  { id: 'stripe_live_key', label: 'Stripe live key', pattern: /\b[rs]k_live_[0-9A-Za-z]{24,}\b/g },
];

/**
 * A documented placeholder, not a credential: `AKIAIOSFODNN7EXAMPLE`,
 * `ghp_xxxxxxxx…`, `sk-000000…`. A real token of these formats is random
 * base62, so it has far more than 8 distinct characters.
 */
function isPlaceholder(token: string): boolean {
  if (/example/i.test(token)) return true;
  return new Set(token).size < 8;
}

/** The rules one line of text matches, each at most once. */
export function secretRulesInLine(text: string): SecretRule[] {
  const hits: SecretRule[] = [];
  for (const rule of SECRET_RULES) {
    for (const match of text.matchAll(rule.pattern)) {
      if (rule.fixedText || !isPlaceholder(match[0])) {
        hits.push(rule);
        break;
      }
    }
  }
  return hits;
}

export interface SecretFinding {
  /** The commit that adds the line (abbreviated), when the scan read a log. */
  commit?: string;
  /** Repository path of the file the line is added to. */
  file: string;
  /** 1-based line number in the new version of the file. */
  line: number;
  /** `SecretRule.id`. */
  rule: string;
  /** `SecretRule.label`. */
  label: string;
}

/** The most findings one scan returns; the total is still counted. */
export const MAX_SECRET_FINDINGS = 50;

export interface SecretScan {
  findings: SecretFinding[];
  /** Every finding, including the ones past `MAX_SECRET_FINDINGS`. */
  total: number;
  /**
   * Set when the scan could not read the whole change (over its bounds, an
   * octopus merge). Unread is not clean: the merge treats it as a finding.
   */
  unscanned?: string;
}

/** A C-quoted git path (`"b/a\tb"`) as text; any other path unchanged. */
function unquoteGitPath(raw: string): string {
  if (!raw.startsWith('"') || !raw.endsWith('"')) return raw;
  const bytes: number[] = [];
  const body = raw.slice(1, -1);
  const escapes: Record<string, number> = { n: 10, t: 9, r: 13, '"': 34, '\\': 92, a: 7, b: 8, f: 12, v: 11 };
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i]!;
    if (ch !== '\\') {
      bytes.push(...Buffer.from(ch, 'utf8'));
      continue;
    }
    const next = body[i + 1] ?? '';
    if (/[0-7]/.test(next)) {
      bytes.push(Number.parseInt(body.slice(i + 1, i + 4), 8));
      i += 3;
    } else {
      bytes.push(escapes[next] ?? next.charCodeAt(0));
      i += 1;
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

/**
 * A path as it may appear in an answer a terminal or a browser shows: every
 * control character (C0, DEL, C1) and every bidirectional or invisible
 * formatting mark is written as `\uXXXX`. A branch names its own files, so a
 * file name must never move the reader's cursor or reorder what they read.
 */
export function printablePath(path: string): string {
  return path.replace(
    /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

/**
 * Scan the lines a unified diff adds: one diff (`git diff -U0 --src-prefix=a/
 * --dst-prefix=b/`) or a log of them (`git log -p -U0 --format='commit %H'`,
 * same prefixes), where each finding also names its commit. Removed lines and
 * context are ignored. Run git with `--text`: a file git would call binary
 * prints `Binary files … differ` and no lines.
 *
 * A hunk is read by its line counts, never by the look of a line: an added
 * line whose text starts with `++` prints as `+++…` and must not be read as a
 * file header.
 */
export function scanAddedLines(patch: string): SecretScan {
  const findings: SecretFinding[] = [];
  let total = 0;
  let commit: string | undefined;
  let file: string | null = null;
  let newLine = 0;
  let oldLeft = 0;
  let newLeft = 0;
  for (const line of patch.split('\n')) {
    if (oldLeft > 0 || newLeft > 0) {
      if (line.startsWith('+')) {
        newLeft -= 1;
        if (file !== null) {
          for (const rule of secretRulesInLine(line.slice(1))) {
            total += 1;
            if (findings.length < MAX_SECRET_FINDINGS) {
              findings.push({ ...(commit ? { commit } : {}), file, line: newLine, rule: rule.id, label: rule.label });
            }
          }
        }
        newLine += 1;
      } else if (line.startsWith('-')) {
        oldLeft -= 1;
      } else if (line.startsWith(' ')) {
        oldLeft -= 1;
        newLeft -= 1;
        newLine += 1;
      }
      // `\ No newline at end of file` belongs to the hunk and counts for neither side.
      continue;
    }
    const commitLine = /^commit ([0-9a-f]{40,64})$/.exec(line);
    if (commitLine) {
      commit = commitLine[1]!.slice(0, 12);
      file = null;
    } else if (line.startsWith('diff --git ')) {
      file = null;
    } else if (line.startsWith('+++ ')) {
      const target = line.slice(4).replace(/\t$/, '');
      const path = unquoteGitPath(target);
      file = path === '/dev/null' ? null : printablePath(path.replace(/^b\//, ''));
    } else if (line.startsWith('@@ ')) {
      const hunk = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!hunk) continue;
      oldLeft = hunk[1] === undefined ? 1 : Number(hunk[1]);
      newLine = Number(hunk[2]);
      newLeft = hunk[3] === undefined ? 1 : Number(hunk[3]);
    }
  }
  return { findings, total };
}

/** `src/config.ts:3 (GitHub token, commit 1a2b3c4d5e6f)`, one per finding, for a message a person reads. */
export function describeSecretFindings(scan: SecretScan, limit = 5): string {
  const shown = scan.findings
    .slice(0, limit)
    .map((f) => `${f.file}:${f.line} (${f.label}${f.commit ? `, commit ${f.commit}` : ''})`);
  const more = scan.total - shown.length;
  return more > 0 ? `${shown.join(', ')} and ${more} more` : shown.join(', ');
}
