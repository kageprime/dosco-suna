import { parseWeeklyMedia, type WeeklyMedia } from './weekly-media';

export interface Announcement {
  title: string;
  text: string;
  media: WeeklyMedia;
  guideUrl: string;
  tags: string[];
}

/** The same reviewed asset policy as weekly covers, on the approved announcement payload. */
export function parseAnnouncements(value: unknown): Announcement[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): Announcement[] => {
    if (!entry || typeof entry !== 'object') return [];
    const { title, text, cover, guide_url, tags } = entry;
    if (
      typeof title !== 'string' ||
      !title.trim() ||
      typeof text !== 'string' ||
      !text.trim() ||
      Array.from(text.trim()).length > 280 ||
      typeof guide_url !== 'string' ||
      !Array.isArray(tags) ||
      !tags.length ||
      !tags.every((tag) => typeof tag === 'string' && /^v\d+\.\d+\.\d+(?:[-.][\w.-]+)?$/.test(tag))
    )
      return [];
    const media = parseWeeklyMedia({ reviewed: true, cover, videoUrl: entry.video_url });
    if (!media) return [];
    try {
      const guide = new URL(guide_url);
      if (guide.protocol !== 'https:' || guide.username || guide.password || guide.port) return [];
      return [{ title: title.trim(), text: text.trim(), media, guideUrl: guide.href, tags }];
    } catch {
      return [];
    }
  });
}
