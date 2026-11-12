import { submitDemoRequest } from '@kortix/sdk';
import { NextRequest, NextResponse } from 'next/server';

import { clientIp, consumeRateLimit } from '@/lib/seo/rate-limit';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// ---------------------------------------------------------------------------
// POST /api/demo-request — public lead capture for the /contact qualifier and
// the careers form.
//
// The API stores the submission (POST /v1/system/demo-request: one row in
// kortix.contact_forms and its Sales outbox event, in one transaction) and then
// sends the internal notification email, best effort. Success needs the stored
// row: anything else answers 503 so the visitor retries.

function isValidEmail(value: string): boolean {
  if (value.length === 0 || value.length > 254) return false;
  for (const char of value) {
    if (char === ' ' || char === '\t' || char === '\r' || char === '\n') return false;
  }
  const at = value.lastIndexOf('@');
  if (at <= 0 || at !== value.indexOf('@') || at === value.length - 1) return false;
  const domain = value.slice(at + 1);
  const dot = domain.lastIndexOf('.');
  return dot > 0 && dot < domain.length - 1;
}

function backendUrl() {
  return (
    process.env.BACKEND_URL ||
    process.env.KORTIX_PUBLIC_BACKEND_URL ||
    process.env.NEXT_PUBLIC_BACKEND_URL ||
    'http://localhost:8008/v1'
  ).replace(/\/$/, '');
}

/** Store the submission through the API. True only when the API confirms the stored row. */
async function store(body: Record<string, unknown>, userAgent: string | null): Promise<boolean> {
  try {
    const result = (await submitDemoRequest(
      { ...body, email: String(body.email ?? '').trim(), user_agent: userAgent ?? undefined },
      { backendUrl: backendUrl(), signal: AbortSignal.timeout(10_000) },
    )) as { persisted?: unknown } | null;
    return result?.persisted === true;
  } catch (err) {
    console.error('[api/demo-request] not stored:', (err as Error).message);
    return false;
  }
}

const MAX_BODY_BYTES = 8 * 1024;
const MAX_FIELD_CHARS = 2000;
const SUBMISSIONS_PER_MINUTE = 5;
// The only keys the forms send. Anything else is dropped, never stored.
const STRING_FIELDS = [
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

export async function POST(request: NextRequest) {
  const rate = consumeRateLimit(`demo-request:${clientIp(request)}`, SUBMISSIONS_PER_MINUTE);
  if (!rate.allowed) {
    return NextResponse.json(
      { error: 'Too many requests' },
      {
        status: 429,
        headers: { 'Retry-After': String(Math.max(1, Math.ceil((rate.resetsAt - Date.now()) / 1000))) },
      },
    );
  }

  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared > MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'Body too large' }, { status: 413 });
  }
  let raw: Record<string, unknown>;
  try {
    const text = await request.text();
    if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) {
      return NextResponse.json({ error: 'Body too large' }, { status: 413 });
    }
    raw = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
  }
  const body: Record<string, unknown> = {};
  for (const key of STRING_FIELDS) {
    if (typeof raw[key] === 'string') body[key] = (raw[key] as string).slice(0, MAX_FIELD_CHARS);
  }
  if (typeof raw.qualified === 'boolean') body.qualified = raw.qualified;

  if (!isValidEmail(String(body.email ?? '').trim())) {
    return NextResponse.json({ error: 'Invalid email' }, { status: 400 });
  }

  const persisted = await store(body, request.headers.get('user-agent')?.slice(0, 500) ?? null);
  if (!persisted) {
    return NextResponse.json({ error: 'Unable to save submission; please retry' },
      { status: 503, headers: { 'Retry-After': '5' } });
  }
  return NextResponse.json({ ok: true, persisted });
}
