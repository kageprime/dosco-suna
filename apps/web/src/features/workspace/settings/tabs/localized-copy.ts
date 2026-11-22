/** Function copy that takes a name; every other function copy takes a count. */
const NAME_PARAMETER_KEYS = new Set(['connectedAs']);

/** Translate the existing copy shape without a second table of identical keys. */
export function localizedCopy<T>(
  defaults: T,
  t: (key: string, values?: Record<string, string | number>) => string,
  prefix = '',
): T {
  if (typeof defaults === 'function') {
    const parameter = NAME_PARAMETER_KEYS.has(prefix) ? 'name' : 'count';
    return ((value: string | number) => t(prefix, { [parameter]: value })) as T;
  }
  if (typeof defaults === 'string') return t(prefix) as T;
  return Object.fromEntries(
    Object.entries(defaults as Record<string, unknown>).map(([key, value]) => [
      key,
      localizedCopy(value, t, prefix ? `${prefix}.${key}` : key),
    ]),
  ) as T;
}
