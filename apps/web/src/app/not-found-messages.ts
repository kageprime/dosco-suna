import type { Messages } from '@/i18n/messages';

/**
 * The `hardcodedUi` strings that `NotFoundState` renders. The root 404 page
 * has no `[locale]` layout, so no `I18nProvider` wraps it. It passes only
 * these strings to its own `NextIntlClientProvider`: the whole namespace is
 * ~1.2 MB and would ride along in every 404 response.
 */
const NOT_FOUND_MESSAGE_KEYS = [
  'autoAppNotFoundJsxText404PageNotFoundf7ea8161',
  'autoAppNotFoundJsxTextThePageYouAreLookingccf1ecc5',
  'autoAppNotFoundJsxTextGoBackToHome7b70f24a',
  'i18nComplete.textc205924de0fe',
] as const;

type Tree = Record<string, unknown>;

function isTree(value: unknown): value is Tree {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The catalog subset the root 404 page needs: `{ hardcodedUi: { …only the keys above } }`. */
export function notFoundMessages(messages: Messages): Messages {
  const source = isTree(messages.hardcodedUi) ? messages.hardcodedUi : {};
  const hardcodedUi: Tree = {};
  for (const key of NOT_FOUND_MESSAGE_KEYS) {
    const path = key.split('.');
    let from: unknown = source;
    for (const part of path) from = isTree(from) ? from[part] : undefined;
    if (from === undefined) continue;
    let into = hardcodedUi;
    for (const part of path.slice(0, -1)) {
      if (!isTree(into[part])) into[part] = {};
      into = into[part] as Tree;
    }
    into[path[path.length - 1]] = from;
  }
  return { hardcodedUi };
}
