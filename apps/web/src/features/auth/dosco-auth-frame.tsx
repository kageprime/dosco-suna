'use client';

import { KortixLogo } from '@kortix/ui/kortix-logo';
import { useBranding } from '@kortix/ui/internal/branding/branding-provider';

import { AuthStoryPane } from '@/features/marketing/auth-story-pane';

/**
 * The frame every Dosco sign-in surface shares (`/auth`, forgot password,
 * reset password): a centered column under the Dosco mark, with the story
 * pane beside it. A branded instance gets its own icon and no story pane.
 * The `/auth` page replaces the story pane with the Deep Forest showcase.
 */
export function useDoscoAuthFrame() {
  const branded = useBranding() !== null;
  return {
    centered: true,
    aside: branded ? undefined : <AuthStoryPane />,
    mark: <KortixLogo variant="icon" size={28} className="text-foreground" />,
  };
}
