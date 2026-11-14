'use client';

/**
 * The API call behind the control you are looking at: a developer panel.
 *
 * It shows a wrapper author the SDK call this app runs and the HTTP request
 * that reaches Kortix, next to the control that performs it. It names Kortix,
 * project ids and source paths, so a customer must never see it: it renders
 * only when `NEXT_PUBLIC_LUMEN_DEV_PANELS=1` at build time, and nothing
 * otherwise.
 *
 * Both blocks are copy-pasteable, and neither ever carries real credentials:
 * the bearer is always the `$KORTIX_MEMBER_TOKEN` placeholder (the token the
 * proxy swaps in) and secret values are never rendered at all
 * (`src/lib/call-snippets.ts` has nowhere to put one).
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
  if (process.env.NEXT_PUBLIC_LUMEN_DEV_PANELS !== '1') return null;
  return (
    <CallSnippetPanel
      snippet={callSnippet(id, context ?? {})}
      authorization={AUTHORIZATION_HEADER}
      className={className}
      defaultOpen={defaultOpen}
      bearerNote={
        <>
          <span className="font-mono">$KORTIX_MEMBER_TOKEN</span> is a placeholder for
          the member&apos;s project-scoped token. Lumen&apos;s server holds it and
          adds it to the request; the browser never holds a Kortix token, and
          nothing here renders a real token or secret value.
        </>
      }
    />
  );
}
