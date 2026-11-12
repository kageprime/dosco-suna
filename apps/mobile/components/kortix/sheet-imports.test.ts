import { describe, expect, it } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Guards the two sheet engines (AGENTS.md, "Bottom sheets"):
 * `KortixBottomSheetModal` renders the iOS native sheet where the binary has
 * it and gorhom elsewhere. gorhom's content parts (`BottomSheetScrollView`,
 * `BottomSheetTextInput`, `useBottomSheetInternal`, …) throw inside a native
 * sheet, so outside `components/kortix/` a file imports only gorhom's TYPES
 * (`import type { BottomSheetModal }`, the ref type). Parts come from
 * `@/components/kortix/sheet-parts`.
 *
 * `app/_layout.tsx` mounts `BottomSheetModalProvider`. Test files mock gorhom
 * and are not checked.
 */

const MOBILE_ROOT = join(import.meta.dir, '..', '..');
const SOURCE_DIRS = ['app', 'components', 'lib', 'hooks', 'stores', 'contexts', 'api', 'types', 'modules'];
const ALLOWED = new Set(['app/_layout.tsx']);
/**
 * Files another change owns while this rule lands. Each still renders a gorhom
 * part inside a sheet and so throws in the iOS native sheet: migrate it to
 * `sheet-parts` and delete it here. The second test fails once one is clean,
 * so the list cannot go stale.
 */
const PENDING = new Set<string>();

type SourceFile = { path: string; source: string };

function sourceFiles(): SourceFile[] {
  const files: SourceFile[] = [];
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        walk(full);
      } else if (/\.(tsx?|jsx?)$/.test(entry.name) && !/\.test\.(tsx?|jsx?)$/.test(entry.name)) {
        files.push({ path: relative(MOBILE_ROOT, full), source: readFileSync(full, 'utf8') });
      }
    }
  };
  for (const dir of SOURCE_DIRS) walk(join(MOBILE_ROOT, dir));
  return files;
}

/** The value (non-type) names a file imports from `@gorhom/bottom-sheet`. */
export function gorhomValueImports(source: string): string[] {
  const names: string[] = [];
  const re = /import\s+(type\s+)?([^;]*?)\s+from\s*['"]@gorhom\/bottom-sheet(?:\/[^'"]*)?['"]/g;
  for (const match of source.matchAll(re)) {
    if (match[1]) continue;
    const clause = match[2].trim();
    const braces = /\{([^}]*)\}/.exec(clause);
    const outside = clause.replace(/\{[^}]*\}/, '').replace(/,/g, ' ').trim();
    if (outside) names.push(outside);
    if (braces) {
      for (const raw of braces[1].split(',')) {
        const name = raw.trim();
        if (name && !name.startsWith('type ')) names.push(name.split(/\s+as\s+/)[0].trim());
      }
    }
  }
  for (const match of source.matchAll(/require\(\s*['"]@gorhom\/bottom-sheet['"]\s*\)/g)) names.push(match[0]);
  return names;
}

function violations(files: SourceFile[]): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of files) {
    if (file.path.startsWith('components/kortix/') || ALLOWED.has(file.path)) continue;
    const names = gorhomValueImports(file.source);
    if (names.length > 0) found.set(file.path, names);
  }
  return found;
}

describe('gorhomValueImports', () => {
  it('a type-only import is allowed', () => {
    expect(gorhomValueImports("import type { BottomSheetModal } from '@gorhom/bottom-sheet';")).toEqual([]);
    expect(gorhomValueImports("import { type BottomSheetModal } from '@gorhom/bottom-sheet';")).toEqual([]);
  });

  it('a content part is a value import', () => {
    expect(
      gorhomValueImports("import { BottomSheetScrollView, type BottomSheetModal } from '@gorhom/bottom-sheet';")
    ).toEqual(['BottomSheetScrollView']);
    expect(gorhomValueImports("import {\n  TouchableOpacity as T,\n} from '@gorhom/bottom-sheet';")).toEqual([
      'TouchableOpacity',
    ]);
    expect(gorhomValueImports("import BottomSheet from '@gorhom/bottom-sheet';")).toEqual(['BottomSheet']);
  });
});

describe('sheet content parts', () => {
  it('outside components/kortix, gorhom is imported for its types only', () => {
    const found = violations(sourceFiles());
    const messages = [...found]
      .filter(([path]) => !PENDING.has(path))
      .map(([path, names]) => `${path}: imports ${names.join(', ')} from '@gorhom/bottom-sheet' — use '@/components/kortix/sheet-parts'`);
    expect(messages).toEqual([]);
  });

  it('every pending file still needs its migration', () => {
    const found = violations(sourceFiles());
    const clean = [...PENDING].filter((path) => !found.has(path));
    expect(clean).toEqual([]);
  });
});
