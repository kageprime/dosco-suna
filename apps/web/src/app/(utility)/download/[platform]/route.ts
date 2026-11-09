import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { ANDROID_APK_URL } from '@kortix/ui/internal/lib/mobile-store-urls';
import {
  detectPlatform,
  isMobilePlatform,
  normalizePlatform,
} from '@kortix/ui/internal/lib/detect-os';
import {
  deploymentChannel,
  desktopReleasesPage,
  getDesktopRelease,
  pickDesktopAsset,
} from '@/features/marketing/download/releases';

/**
 * Download redirector — hand-writable URLs that go in emails, docs, chats.
 *
 *   /download/macos   → latest universal .dmg
 *   /download/windows → latest .exe
 *   /download/linux   → latest x86_64 .AppImage
 *   /download/android → the current installable APK, straight from EAS
 *                        (mobile-store-urls.ts; immutable per build)
 *   /download/mobile  → if Android, the APK; else the /download page
 *   /download/<other> → the /download page or release page
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

  const os = normalizePlatform(platform);
  if (os === 'android') {
    return NextResponse.redirect(ANDROID_APK_URL, 302);
  }

  const channel = deploymentChannel();
  const fallback = desktopReleasesPage(channel);

  if (!os || isMobilePlatform(os)) {
    return NextResponse.redirect(new URL('/download', request.nextUrl.origin), 302);
  }

  const release = await getDesktopRelease(channel);
  const asset = release ? pickDesktopAsset(release.assets, os) : undefined;
  return NextResponse.redirect(asset?.url ?? fallback, 302);
}
