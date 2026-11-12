import { Button } from '@kortix/ui/button';
import { AuthFrame } from '@kortix/ui/internal/auth/auth-card-shell';
import { OutcomeTitle } from '@kortix/ui/internal/auth/auth-consent';
import { Rise, StepHeader } from '@kortix/ui/internal/auth/auth-primitives';
import type { ReactNode } from 'react';

import { KortixLogo } from '@/components/sidebar/kortix-logo';

import { SHARE_PAGE_ROOT_CLASS } from './session/[token]/share-layout';

/** The chrome every public share page renders: the bg-card canvas root, the
 *  page's header slot, and one rounded sheet — the h-12 bar above, the shared
 *  content below. */
export function ShareChrome({
  header,
  sheetClassName,
  children,
}: {
  /** `ShareHeader` builds the common bar; a page with its own top slot (the
   *  session share's full-screen exit) passes it here. */
  header?: ReactNode;
  /** The sheet's exact classes: each page owns its overflow (`overflow-clip`
   *  vs `overflow-hidden` vs `overflow-y-auto`). */
  sheetClassName: string;
  children: ReactNode;
}) {
  return (
    <main className={SHARE_PAGE_ROOT_CLASS}>
      {header}
      <section className={sheetClassName}>{children}</section>
    </main>
  );
}

/** The h-12 bar: the Kortix symbol, the shared content's title, the page's actions. */
export function ShareHeader({ title, actions }: { title: ReactNode; actions?: ReactNode }) {
  return (
    // Bar shape copied from the file viewer toolbar (file-preview-modal.tsx):
    // h-12, gap-2, px-3, name left, actions right. No border-b — the pane
    // below draws the seam with its own top border.
    <header className="flex h-12 shrink-0 items-center gap-3 pr-3 pl-4">
      <div className="flex min-w-0 flex-1 items-center gap-2.5">
        <KortixLogo variant="symbol" size={16} className="shrink-0" />
        <h1 className="truncate text-sm font-medium">{title}</h1>
      </div>
      {actions}
    </header>
  );
}

/** The quiet unavailable block: the auth frame, like every other link a
 *  recipient can land on. */
export function ShareUnavailable({
  title,
  description,
  cta,
}: {
  title: ReactNode;
  description: ReactNode;
  /** The call to action: a `Link` inside the `asChild` button. */
  cta: ReactNode;
}) {
  return (
    <AuthFrame footerVariant="none">
      <Rise>
        <StepHeader
          title={<OutcomeTitle tone="muted">{title}</OutcomeTitle>}
          description={description}
        />
      </Rise>
      <Rise delay={0.06}>
        <Button size="lg" variant="secondary" className="w-full" asChild>
          {cta}
        </Button>
      </Rise>
    </AuthFrame>
  );
}
