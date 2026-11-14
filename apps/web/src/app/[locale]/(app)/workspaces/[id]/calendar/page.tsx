'use client';

import { useParams } from 'next/navigation';

import { CalendarPage } from '@kortix/ui/workspace/calendar/calendar-page';

/** /workspaces/[id]/calendar — the week or month, with an item's detail beside it (the layout gates the flag). */
export default function ProjectCalendarPage() {
  const { id } = useParams<{ id: string }>();
  return <CalendarPage projectId={id} />;
}
