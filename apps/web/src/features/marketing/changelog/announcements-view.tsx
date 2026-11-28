'use client';

import { useTranslations } from '@/i18n/use-translations';
import { Badge } from '@kortix/ui/badge';
import type { Announcement } from './announcements';
import { WeeklyCover } from './weekly-cover';

export function AnnouncementsView({ announcements }: { announcements?: Announcement[] }) {
  const t = useTranslations('hardcodedUi.i18nComplete');
  if (!announcements?.length) return null;
  return (
    <div className="mb-8 space-y-8">
      {announcements.map((announcement, index) => (
        <article key={index} className="space-y-4">
          <h3 className="text-foreground text-xl font-medium tracking-tight">
            <a href={announcement.guideUrl} className="underline-offset-4 hover:underline">
              {announcement.title}
            </a>
          </h3>
          <WeeklyCover media={announcement.media} />
          <p className="text-foreground text-base">{announcement.text}</p>
          <div className="flex flex-wrap gap-2">
            {announcement.tags.map((tag) => (
              <Badge key={tag} size="sm" variant="outline" asChild>
                <a href={`/changelog#${encodeURIComponent(tag)}`}>{tag}</a>
              </Badge>
            ))}
          </div>
          <a
            href={announcement.guideUrl}
            className="text-foreground text-sm underline underline-offset-4"
          >
            {t('text83b3b277abbf')}
          </a>
        </article>
      ))}
    </div>
  );
}
