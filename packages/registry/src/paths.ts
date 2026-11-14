/**
 * Path helpers shared by build + fetch, and the `@alias` targets that
 * `kortix registry build` writes (see `TARGET_ALIASES` in `schema.ts`).
 */

export function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end -= 1;
  return value.slice(0, end);
}

export function posixJoin(...parts: string[]): string {
  return parts
    .filter((p) => p && p !== '.')
    .join('/')
    .replace(/\/{2,}/g, '/')
    .replace(/^\.\//, '');
}

export function posixDirname(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? '' : p.slice(0, i);
}

// --- target builders (used by `kortix registry build`) ---------------------

export const buildTarget = {
  skill: (name: string, rel: string) => `@skills/${name}/${rel}`,
  agent: (file: string) => `@agents/${file}`,
};
