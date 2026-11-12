// Lead and application submissions from the web forms (/contact qualifier, careers). One row in
// kortix.contact_forms per submission; its AFTER INSERT trigger (kortix.enqueue_demo_requested)
// writes the Sales outbox event in the same transaction, so a lead is never stored without it.
// Moved from the Suna-era public.contact_forms (migration freeze_legacy_suna_tables).
import { contactForms } from '@kortix/db';
import { db } from '../../shared/db';

/** The only keys a form sends. Anything else is dropped, never stored. */
export const CONTACT_FORM_STRING_FIELDS = [
  'name',
  'email',
  'company_name',
  'company_size',
  'goal',
  'source',
  'opening',
  'owned',
  'link',
] as const;
export const CONTACT_FORM_MAX_FIELD_CHARS = 2000;

export interface ContactFormSubmission {
  fields: Record<string, unknown>;
  /** The visitor's browser, as the web server saw it (this API sees the web server). */
  userAgent: string | null;
}

/** The stored `data` object: the allowed fields, `qualified`, the form kind, and the user agent. */
export function contactFormData(input: ContactFormSubmission): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const key of CONTACT_FORM_STRING_FIELDS) {
    const value = input.fields[key];
    if (typeof value === 'string') data[key] = value.slice(0, CONTACT_FORM_MAX_FIELD_CHARS);
  }
  if (typeof input.fields.qualified === 'boolean') data.qualified = input.fields.qualified;
  data.form = data.opening || String(data.source ?? '').startsWith('careers') ? 'careers' : 'contact';
  data.user_agent = input.userAgent?.slice(0, 500) ?? null;
  return data;
}

/** Store one submission. Throws when the row (and its Sales event) did not commit. */
export async function saveContactForm(input: ContactFormSubmission): Promise<{ id: string }> {
  const [row] = await db.insert(contactForms).values({ data: contactFormData(input) }).returning({ id: contactForms.id });
  if (!row) throw new Error('contact form insert returned no row');
  return row;
}
