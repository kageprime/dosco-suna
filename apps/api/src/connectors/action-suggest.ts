/**
 * The closest action names to one a caller guessed wrong. An agent that calls
 * `gmail GMAIL_GET_PROFILE` (a vendor's tool slug) on a connector whose action
 * is `get_profile` is told the right name in the denial, instead of retrying
 * guesses (prod, 2026-11-11: two `action_not_found` before the right call).
 */

/** Lowercase, every run of non-alphanumerics one `_`: `GMAIL-Get.Profile` → `gmail_get_profile`. */
const normalize = (name: string): string =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[b.length]!;
}

/**
 * The requested name with 0, 1, 2… leading words dropped: a vendor prefix
 * (`GMAIL_`, `gmail.`) is the usual difference.
 */
function suffixes(requested: string): string[] {
  const words = requested.split('_').filter(Boolean);
  return words.map((_, i) => words.slice(i).join('_'));
}

/**
 * Up to `limit` action paths closest to `requested`, best first. A path that
 * equals the requested name after its prefix is dropped ranks first; then the
 * smallest edit distance, within a third of the name's length (at least 2).
 * An empty list means nothing is close.
 */
export function closestActionPaths(requested: string, paths: readonly string[], limit = 3): string[] {
  const wanted = normalize(requested);
  if (!wanted) return [];
  const tails = suffixes(wanted);
  const scored: Array<{ path: string; score: number }> = [];
  for (const path of new Set(paths)) {
    const candidate = normalize(path);
    if (!candidate) continue;
    // Exact after a dropped prefix: the more of the name kept, the better.
    const exactAt = tails.indexOf(candidate);
    if (exactAt >= 0) {
      scored.push({ path, score: exactAt / 100 });
      continue;
    }
    const distance = Math.min(...tails.map((tail) => editDistance(tail, candidate)));
    const budget = Math.max(2, Math.floor(candidate.length / 3));
    if (distance <= budget) scored.push({ path, score: distance });
  }
  return scored
    .sort((a, b) => a.score - b.score || a.path.localeCompare(b.path))
    .slice(0, limit)
    .map((entry) => entry.path);
}
