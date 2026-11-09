/**
 * The message text of an unknown caught error: an `Error`'s `message`, else
 * its string form. The one shape every `catch` in the API logs or echoes —
 * one helper replaces the inline ternary each of those sites used to spell.
 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
