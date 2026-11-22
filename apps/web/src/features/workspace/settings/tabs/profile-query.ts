'use client';

import { useQuery } from '@tanstack/react-query';

import { createClient } from '@/lib/supabase/client';

export const PROFILE_QUERY_KEY = ['account', 'profile'] as const;

export interface ProfileIdentity {
  name: string;
  email: string;
  avatarUrl: string;
}

/**
 * The signed-in person's name, email and picture. The Profile pane edits them;
 * the Preferences sidebar header shows them. One query key, so an edit in the
 * pane refreshes the header too.
 */
export function useProfileIdentity(enabled = true) {
  return useQuery({
    queryKey: PROFILE_QUERY_KEY,
    queryFn: async (): Promise<ProfileIdentity> => {
      const { data } = await createClient().auth.getUser();
      return {
        name: data.user?.user_metadata?.name || data.user?.email?.split('@')[0] || '',
        email: data.user?.email || '',
        avatarUrl: data.user?.user_metadata?.avatar_url || '',
      };
    },
    staleTime: 10_000,
    enabled,
  });
}

export function profileInitials(name: string): string {
  return (
    name
      .split(' ')
      .map((part) => part[0])
      .join('')
      .toUpperCase()
      .slice(0, 2) || 'U'
  );
}
