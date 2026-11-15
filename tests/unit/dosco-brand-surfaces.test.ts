/**
 * Dosco Brand Surfaces Guard
 *
 * Fast (<100ms) regression test verifying that customer-facing surfaces
 * retain Dosco / Dosco Tek branding and do not leak upstream Kortix strings,
 * GitHub star badges, or 'Kortix workspace' prefixes.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const WEB_SRC = join(REPO_ROOT, 'apps', 'web', 'src');

describe('Dosco brand surfaces guard', () => {
  describe('Navbar and Header surfaces', () => {
    test('home navbar does not leak upstream GitHub repo link or star count', () => {
      const navbarPath = join(WEB_SRC, 'components', 'home', 'navbar.tsx');
      expect(existsSync(navbarPath)).toBe(true);

      const content = readFileSync(navbarPath, 'utf8');
      expect(content).not.toContain('github.com/kortix-ai');
      expect(content).not.toContain('kortix-ai/CompanyOS');
      expect(content).not.toContain('useGitHubStars');
      expect(content).not.toMatch(/label:\s*['"]Kortix['"]/);
    });
  });

  describe('SEO and structured metadata', () => {
    test('root locale layout does not contain Kortix GitHub repository link', () => {
      const layoutPath = join(WEB_SRC, 'app', '[locale]', 'layout.tsx');
      expect(existsSync(layoutPath)).toBe(true);

      const content = readFileSync(layoutPath, 'utf8');
      expect(content).not.toContain('github.com/kortix-ai');
      expect(content).not.toContain('SoftwareSourceCode');
    });

    test('agent discovery card does not link to upstream GitHub repository', () => {
      const discoveryPath = join(WEB_SRC, 'lib', 'agent-discovery.ts');
      expect(existsSync(discoveryPath)).toBe(true);

      const content = readFileSync(discoveryPath, 'utf8');
      expect(content).not.toContain('github.com/kortix-ai');
    });

    test('CLI installer route points to Dosco repo, not upstream', () => {
      const installRoutePath = join(WEB_SRC, 'app', '(utility)', 'install', 'route.ts');
      expect(existsSync(installRoutePath)).toBe(true);

      const content = readFileSync(installRoutePath, 'utf8');
      expect(content).not.toContain('github.com/kortix-ai');
      expect(content).not.toContain('kortix-ai/CompanyOS');
    });

    test('capture rollout model does not link to upstream repo', () => {
      const rolloutPath = join(WEB_SRC, 'features', 'capture', 'devices', 'rollout-model.ts');
      expect(existsSync(rolloutPath)).toBe(true);

      const content = readFileSync(rolloutPath, 'utf8');
      expect(content).not.toContain('github.com/kortix-ai');
      expect(content).not.toContain('kortix-ai/CompanyOS');
    });

    test('public-content marketing records do not contain Kortix branded product titles', () => {
      const publicContentPath = join(WEB_SRC, 'lib', 'seo', 'public-content.ts');
      expect(existsSync(publicContentPath)).toBe(true);

      const content = readFileSync(publicContentPath, 'utf8');
      expect(content).not.toContain('Kortix for Enterprise');
      expect(content).not.toContain('The Kortix framework');
      expect(content).not.toContain('Kortix desktop app');
      expect(content).not.toContain('Kortix mobile app');
      expect(content).not.toContain('Add them to a Kortix workspace');
    });
  });

  describe('Translation catalogs and i18n', () => {
    test('en.json has zero occurrences of "Kortix workspace"', () => {
      const enJsonPath = join(REPO_ROOT, 'apps', 'web', 'translations', 'en.json');
      expect(existsSync(enJsonPath)).toBe(true);

      const content = readFileSync(enJsonPath, 'utf8');
      const matches = content.match(/Kortix workspace/gi);
      expect(matches).toBeNull();
    });

    test('en.json has zero occurrences of "My Kortix"', () => {
      const enJsonPath = join(REPO_ROOT, 'apps', 'web', 'translations', 'en.json');
      const content = readFileSync(enJsonPath, 'utf8');
      const matches = content.match(/My Kortix/gi);
      expect(matches).toBeNull();
    });

    test('en.json has zero occurrences of notification prompt leaks ("Kortix is closed" / "when Kortix")', () => {
      const enJsonPath = join(REPO_ROOT, 'apps', 'web', 'translations', 'en.json');
      const content = readFileSync(enJsonPath, 'utf8');
      expect(content).not.toMatch(/when Kortix/i);
      expect(content).not.toMatch(/Kortix notifies you/i);
      expect(content).not.toMatch(/Kortix is closed/i);
    });

    test('compiled UI catalog en.ts has zero occurrences of "Kortix workspace"', () => {
      const enTsPath = join(REPO_ROOT, 'packages', 'ui', 'src', 'i18n', 'en.ts');
      expect(existsSync(enTsPath)).toBe(true);

      const content = readFileSync(enTsPath, 'utf8');
      const matches = content.match(/Kortix workspace/gi);
      expect(matches).toBeNull();
    });

    test('compiled UI catalog en.ts has zero occurrences of "My Kortix"', () => {
      const enTsPath = join(REPO_ROOT, 'packages', 'ui', 'src', 'i18n', 'en.ts');
      const content = readFileSync(enTsPath, 'utf8');
      const matches = content.match(/My Kortix/gi);
      expect(matches).toBeNull();
    });

    test('compiled UI catalog en.ts has zero occurrences of notification prompt leaks ("Kortix is closed" / "when Kortix")', () => {
      const enTsPath = join(REPO_ROOT, 'packages', 'ui', 'src', 'i18n', 'en.ts');
      const content = readFileSync(enTsPath, 'utf8');
      expect(content).not.toMatch(/when Kortix/i);
      expect(content).not.toMatch(/Kortix notifies you/i);
      expect(content).not.toMatch(/Kortix is closed/i);
    });
  });

  describe('Marketing pages and hero sections', () => {
    test('framework hero does not contain upstream GitHub link', () => {
      const heroPath = join(WEB_SRC, 'features', 'marketing', 'framework', 'framework-hero.tsx');
      expect(existsSync(heroPath)).toBe(true);

      const content = readFileSync(heroPath, 'utf8');
      expect(content).not.toContain('github.com/kortix-ai');
    });

    test('launch content does not contain upstream GitHub link', () => {
      const launchPath = join(WEB_SRC, 'features', 'marketing', 'launch', 'content.ts');
      expect(existsSync(launchPath)).toBe(true);

      const content = readFileSync(launchPath, 'utf8');
      expect(content).not.toContain('github.com/kortix-ai');
    });

    test('open-source content does not contain upstream GitHub star references', () => {
      const openSourcePath = join(WEB_SRC, 'features', 'marketing', 'open-source', 'content.ts');
      expect(existsSync(openSourcePath)).toBe(true);

      const content = readFileSync(openSourcePath, 'utf8');
      expect(content).not.toContain('github.com/kortix-ai');
    });
  });

  describe('Broad scan: no upstream GitHub repo links in web components or marketing', () => {
    function scanDirectory(dir: string, results: string[] = []): string[] {
      if (!existsSync(dir)) return results;
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          scanDirectory(fullPath, results);
        } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))) {
          if (!entry.name.includes('.test.') && !entry.name.includes('.spec.')) {
            const fileContent = readFileSync(fullPath, 'utf8');
            if (fileContent.includes('github.com/kortix-ai/CompanyOS')) {
              results.push(fullPath);
            }
          }
        }
      }
      return results;
    }

    test(
      'apps/web public components and marketing features do not reference github.com/kortix-ai/CompanyOS',
      () => {
        const homeDir = join(WEB_SRC, 'components', 'home');
        const marketingDir = join(WEB_SRC, 'features', 'marketing');

        const matches = [
          ...scanDirectory(homeDir),
          ...scanDirectory(marketingDir),
        ];

        expect(matches).toEqual([]);
      },
      { timeout: 15000 },
    );
  });

  describe('Marketing runtime assets, blog rewrite guard, and translation catalog', () => {
    test('apps/web/public/marketing/dither-wordmark.png exists and is non-empty', () => {
      const wordmarkPath = join(REPO_ROOT, 'apps', 'web', 'public', 'marketing', 'dither-wordmark.png');
      expect(existsSync(wordmarkPath)).toBe(true);
      expect(statSync(wordmarkPath).size).toBeGreaterThan(1000);
    });

    test('apps/web/src/config/blog-origin.ts leaves DEFAULT_BLOG_ORIGIN unset and guards self-origin /blog loops', () => {
      const blogOriginPath = join(WEB_SRC, 'config', 'blog-origin.ts');
      const content = readFileSync(blogOriginPath, 'utf8');
      expect(content).toContain('const DEFAULT_BLOG_ORIGIN: string | undefined = undefined;');
      expect(content).toContain('SELF_BLOG_ORIGINS');
      expect(content).toContain("'https://dosco.live'");
    });

    test('apps/web/translations/en.json has no banned upstream, Platinum, OSS, or prefixed brand phrases', () => {
      const enPath = join(REPO_ROOT, 'apps', 'web', 'translations', 'en.json');
      const content = readFileSync(enPath, 'utf8');
      const banned = [
        'Kortix Cloud',
        'Dosco Cloud',
        'Dosco Capture',
        'Dosco CompanyOS',
        'Dosco Drive',
        'Kortix Drive',
        'Kortix Capture',
        'My Kortix',
        'Platinum microVM',
        'Platinum compute',
        'runs on Platinum',
        'free to self-host',
        '20,000+ GitHub stars',
        '20,000 GitHub stars',
        'github.com/kortix-ai',
        'github.com/dosco-ai',
        'security@kortix.com',
        'legal@kortix.com',
        'privacy@kortix.com',
        '@markokraemer',
        'KORTIX DOES NOT WARRANT',
        'One Docker Compose stack.',
      ];
      for (const phrase of banned) {
        expect(content).not.toContain(phrase);
      }
    });

    test('apps/web marketing and home code contain no banned Dosco brand prefixes or upstream GitHub links', () => {
      const dirs = [
        join(WEB_SRC, 'components', 'home'),
        join(WEB_SRC, 'features', 'marketing'),
      ];
      const bannedPatterns = [
        /Kortix Cloud/i,
        /Dosco Cloud/,
        /Dosco CompanyOS/,
        /My Kortix/,
        /github\.com\/kortix-ai/,
        /github\.com\/dosco-ai/,
        /security@kortix\.com/i,
        /One Docker Compose stack/,
      ];
      const hits: string[] = [];
      const walk = (dir: string) => {
        for (const entry of readdirSync(dir)) {
          const full = join(dir, entry);
          const st = statSync(full);
          if (st.isDirectory()) {
            if (entry === '__snapshots__' || entry === 'node_modules') continue;
            walk(full);
          } else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.(ts|tsx)$/.test(entry)) {
            const stripped = readFileSync(full, 'utf8')
              .replace(/\/\*[\s\S]*?\*\//g, '')
              .replace(/^\s*\/\/.*$/gm, '');
            for (const re of bannedPatterns) {
              if (re.test(stripped)) {
                hits.push(`${full}: ${re}`);
              }
            }
          }
        }
      };
      for (const d of dirs) walk(d);
      expect(hits).toEqual([]);
    });
  });
});
