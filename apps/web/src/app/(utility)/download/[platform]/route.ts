import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { ANDROID_APK_URL } from '@kortix/ui/internal/lib/mobile-store-urls';
import {
  detectPlatform,
  normalizePlatform,
} from '@/features/marketing/download/detect-os';

/**
 * Download redirector — hand-writable URLs that go in emails, docs, chats.
 *
 *   /download/android  → the current installable APK, straight from EAS
 *                        (mobile-store-urls.ts; immutable per build)
 *   /download/mobile   → if Android, the APK; else the /download page
 *   /download/<other>  → the /download page
 *
 * The Dosco apps are the web app and the Android APK: no desktop, no iOS.
 * A hand-typed desktop or iOS URL lands on the /download page, which offers
 * exactly what exists, instead of serving another product's installers. The
 * redirect target is absolute: NextResponse.redirect rejects relative URLs.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ platform: string }> },
) {
  const { platform } = await params;
  if (platform.toLowerCase() === 'mobile') {
    const detected = detectPlatform(request.headers.get('user-agent'));
    if (detected === 'android') return NextResponse.redirect(ANDROID_APK_URL, 302);
    return NextResponse.redirect(new URL('/download', request.nextUrl.origin), 302);
  }

  if (normalizePlatform(platform) === 'android') {
    return NextResponse.redirect(ANDROID_APK_URL, 302);
  }
  return NextResponse.redirect(new URL('/download', request.nextUrl.origin), 302);
}
