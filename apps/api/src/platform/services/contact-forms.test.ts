import { describe, expect, test } from 'bun:test';
import { contactFormData } from './contact-forms';

describe('contactFormData: what a web form submission stores', () => {
  test('keeps only the known fields, truncated to 2,000 characters, and derives the form kind', () => {
    const data = contactFormData({
      fields: { email: 'a@b.co', goal: 'g'.repeat(5000), junk: { a: 1 }, form: 'forged', qualified: true },
      userAgent: 'synthetic-browser/1.0',
    });
    expect(Object.keys(data).sort()).toEqual(['email', 'form', 'goal', 'qualified', 'user_agent']);
    expect(data.form).toBe('contact');
    expect((data.goal as string).length).toBe(2000);
    expect(data.user_agent).toBe('synthetic-browser/1.0');
  });

  test('a careers source or an opening is a careers row, which never reaches Sales', () => {
    expect(contactFormData({ fields: { email: 'a@b.co', source: 'careers-page' }, userAgent: null }).form).toBe('careers');
    expect(contactFormData({ fields: { email: 'a@b.co', opening: 'Engineer' }, userAgent: null }).form).toBe('careers');
  });
});
