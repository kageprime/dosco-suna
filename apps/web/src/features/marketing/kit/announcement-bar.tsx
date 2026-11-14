import Link from '@/components/site-link';

/** The height the bar takes at the top of the page: the shell reserves the same. */
export const ANNOUNCEMENT_BAR_HEIGHT = 'h-9';

/**
 * One line above the navbar, in the brand accent: the newest thing on the
 * site, as a link. One announcement at a time; remove the bar when there is
 * none.
 */
export function AnnouncementBar() {
  return (
    <Link
      href="/loopmaxxing"
      className={`bg-kortix-base outline-ring flex ${ANNOUNCEMENT_BAR_HEIGHT} w-full items-center justify-center gap-2 px-4 text-sm text-white focus-visible:outline-2 focus-visible:-outline-offset-2`}
    >
      <span className="font-medium">New: Loopmaxxing.</span>
      <span className="hidden truncate sm:inline">Add a software factory to your repo with 1 prompt.</span>
      <span aria-hidden>→</span>
    </Link>
  );
}
