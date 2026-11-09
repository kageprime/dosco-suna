/** `m:ss` from a whole number of seconds: minutes unbounded, seconds zero-padded. */
export function formatClock(seconds: number, { padMinutes = false }: { padMinutes?: boolean } = {}): string {
  const minutes = Math.floor(seconds / 60);
  const mm = padMinutes ? String(minutes).padStart(2, '0') : String(minutes);
  return `${mm}:${String(seconds % 60).padStart(2, '0')}`;
}
