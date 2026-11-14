import { describe, expect, test } from 'bun:test';
import { ESLint } from 'eslint';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const sdkImport = "import { getClient } from '@kortix/sdk';";
const literalKey = "export const options = { queryKey: ['project-widgets'] as const };";

for (const owner of ['apps/web', 'packages/ui']) {
  describe(`${owner} effective lint policy`, () => {
    const eslint = new ESLint({ cwd: resolve(root, owner) });
    async function diagnostics(source, filePath = 'src/policy-probe.tsx') {
      const [result] = await eslint.lintText(source, { filePath });
      return result.messages.map(({ ruleId, severity }) => ({ ruleId, severity }));
    }

    test('SDK entrypoints and literal query keys stay error-level guards', async () => {
      expect(await diagnostics(sdkImport)).toContainEqual({ ruleId: 'no-restricted-imports', severity: 2 });
      expect(await diagnostics(literalKey)).toContainEqual({ ruleId: 'no-restricted-syntax', severity: 2 });
      expect(await diagnostics("import { useSession } from '@kortix/sdk/react';")).toEqual([]);
      expect(await diagnostics("import { cache } from '@kortix/sdk/idb-sync-cache';")).toContainEqual({ ruleId: 'no-restricted-imports', severity: 2 });
    });

    test('every query-key rule family rejects both the plain and the `as const` literal', async () => {
      const rejected = { ruleId: 'no-restricted-syntax', severity: 2, message: 'Query keys come from `qk` in @kortix/sdk/react. Never hand-type an entity key.' };
      for (const key of [
        "export const options = { queryKey: ['project-detail', id] };",
        "export const options = { queryKey: ['project-detail', id] as const };",
        "export const options = { queryKey: ['kx', 'projects'] };",
        "export const options = { queryKey: ['kx', 'projects'] as const };",
        "client.setQueryData(['accounts'], data);",
        "client.invalidateQueries(['kx', 'project', id] as const);",
      ]) {
        const [result] = await eslint.lintText(key, { filePath: 'src/policy-probe.tsx' });
        expect(result.messages.map(({ ruleId, severity, message }) => ({ ruleId, severity, message }))).toContainEqual(rejected);
      }
      expect(await diagnostics("export const options = { queryKey: ['account', id] as const };")).toEqual([]);
    });

    test('icon restrictions retain their current scope and precedence', async () => {
      expect(await diagnostics("import { Icon } from 'lucide-react';", 'policy-probe.tsx')).toContainEqual({ ruleId: 'no-restricted-imports', severity: 2 });
      // The SDK restriction replaces no-restricted-imports inside src, rather than merging patterns.
      expect(await diagnostics("import { Icon } from 'lucide-react';")).toEqual([]);
    });

    test('static navigation and location assignment are errors; documented dynamic navigation is allowed', async () => {
      expect(await diagnostics('export const Control = () => <button onClick={() => router.push("/projects/synthetic")} />;')).toContainEqual({ ruleId: 'nav-contract/no-router-push-for-static-href', severity: 2 });
      expect(await diagnostics('window.location.href = "/projects/synthetic";')).toContainEqual({ ruleId: '@next/next/no-location-assign-relative-destination', severity: 2 });
      expect(await diagnostics('export const Control = () => <button onClick={() => {\n// nav-contract: prefetch-only — destination comes from creation\nrouter.push("/projects/synthetic");\n}} />;')).toEqual([]);
    });

    test('ordinary UI paths are not exempted by web-local shim paths', async () => {
      expect(await diagnostics(sdkImport, 'src/internal/lib/iam-client.ts')).toContainEqual({ ruleId: 'no-restricted-imports', severity: 2 });
      expect(await diagnostics(literalKey, 'src/internal/lib/iam-client.ts')).toContainEqual({ ruleId: 'no-restricted-syntax', severity: 2 });
    });
  });
}

describe('web-owned exceptions', () => {
  const eslint = new ESLint({ cwd: resolve(root, 'apps/web') });
  test('IAM shim and SSR wrapper retain their import exemptions', async () => {
    for (const filePath of ['src/lib/iam-client.ts', 'src/lib/icons/ssr.tsx']) {
      const [result] = await eslint.lintText(sdkImport, { filePath });
      expect(result.messages).toEqual([]);
    }
  });
});
