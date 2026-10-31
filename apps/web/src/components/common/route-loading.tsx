import { BreathingCrest } from '@/components/ui/breathing-crest';

/**
 * Shared fallback for Next.js route-segment `loading.tsx` files — the Dosco
 * fiery animated brand loader, shown during navigation/streaming instead of a blank frame.
 */
export function RouteLoadingFallback() {
  return (
    <div className="flex min-h-[60vh] w-full items-center justify-center">
      <BreathingCrest size={72} />
    </div>
  );
}
