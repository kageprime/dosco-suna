/**
 * The one parser behind the settings panel's optional integer fields (the
 * session-policy minutes and the key-rules days). Three rules, asserted by the
 * forms' tests: blank means "no limit" (the field is optional, not invalid),
 * the value is a whole number above zero, and the server's cap is allowed
 * exactly. Each form keeps its own sentences — it passes the two messages it
 * wants, built from its own catalog keys.
 */

type OptionalIntField =
  | { ok: true; value: number | null }
  | { ok: false; error: string };

/** The two sentences a form shows: one per failure rule. */
interface OptionalIntFieldMessages {
  notInteger: string;
  overMax: string;
}

export function parseOptionalIntField(
  raw: string,
  max: number,
  messages: OptionalIntFieldMessages,
): OptionalIntField {
  const trimmed = raw.trim();
  if (trimmed === '') return { ok: true, value: null };
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return { ok: false, error: messages.notInteger };
  }
  if (parsed > max) {
    return { ok: false, error: messages.overMax };
  }
  return { ok: true, value: parsed };
}

/** The stored value as the input shows it — `null` is an empty field. */
export function toField(value: number | null | undefined): string {
  return value?.toString() ?? '';
}
