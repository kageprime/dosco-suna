import type { ProjectSessionStatus } from '@kortix/sdk';
import { LocalTime } from '@kortix/ui/local-time';
import { StatusBadge, type StatusTone } from '@kortix/ui/status';
import type { ReactNode } from 'react';
import { Link } from './router';

export function Centered({ children }: { children: ReactNode }) {
  return <div className="grid min-h-dvh place-items-center bg-background p-6">{children}</div>;
}

const TONES: Record<ProjectSessionStatus, StatusTone> = {
  queued: 'info',
  branching: 'info',
  provisioning: 'info',
  running: 'success',
  stopped: 'neutral',
  completed: 'neutral',
  failed: 'destructive',
};

export function SessionStatus({ status }: { status: ProjectSessionStatus }) {
  return <StatusBadge tone={TONES[status] ?? 'neutral'}>{status}</StatusBadge>;
}

export function PageTitle({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="mb-5 flex items-center gap-3">
      <h1 className="text-lg font-medium">{title}</h1>
      <div className="ml-auto flex items-center gap-2">{children}</div>
    </div>
  );
}

/** A table row's primary link. The stretched hit area makes the whole row clickable. */
export function RowLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="after:absolute after:inset-0 hover:underline">
      {children}
    </Link>
  );
}

export function When({ value }: { value: string }) {
  return <LocalTime value={value} options={{ dateStyle: 'medium', timeStyle: 'short' }} />;
}
