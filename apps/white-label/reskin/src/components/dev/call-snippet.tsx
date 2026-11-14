'use client';

/**
 * The API call behind the control you are looking at.
 *
 * Lumen Workspace exists to show a wrapper author what to call, and until this panel
 * existed every answer lived in the source: the dialog started a session and
 * nothing on screen said which request that was. So each KaaB control carries
 * its own disclosure, showing the SDK call this app runs and the HTTP request
 * that reaches Kortix — next to the button that performs it, not in a README.
 *
 * Both blocks are copy-pasteable, and neither ever carries real credentials:
 * the bearer is always the `$KORTIX_API_KEY` placeholder and secret values are
 * never rendered at all (`src/lib/call-snippets.ts` has nowhere to put one).
 */

import {
  AUTHORIZATION_HEADER,
  type CallSnippetId,
  type SnippetContext,
  callSnippet,
} from '@/lib/call-snippets';
import { CallSnippetPanel } from '@kortix/white-label-shared/call-snippet';

export function CallSnippet({
  id,
  context,
  className,
  defaultOpen = false,
}: {
  id: CallSnippetId;
  context?: SnippetContext;
  className?: string;
  defaultOpen?: boolean;
}) {
  return (
    <CallSnippetPanel
      snippet={callSnippet(id, context ?? {})}
      authorization={AUTHORIZATION_HEADER}
      className={className}
      defaultOpen={defaultOpen}
      bearerNote={
        <>
          <span className="font-mono">$KORTIX_API_KEY</span> is a placeholder.
          Nothing here ever renders a real key, token or secret value — the
          key stays on your server, and the end user&apos;s own token never
          reaches Kortix.
        </>
      }
    />
  );
}
