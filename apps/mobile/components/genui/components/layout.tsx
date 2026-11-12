import { useState } from 'react';
import { Pressable, ScrollView, useWindowDimensions, View } from 'react-native';
import { ScrollView as GHScrollView } from 'react-native-gesture-handler';
import type { GenuiNode } from '@kortix/sdk/genui';
import type { GenuiComponentProps } from '@kortix/sdk/genui/react';
import { CARD_TEXT_RATIO, cardImageShape, cardListLayout, type CardShape, masonryColumns, UNKNOWN_RATIO } from '@kortix/shared/genui-layout';
import { useTranslation } from 'react-i18next';

import { PagedGallery } from '@/components/kortix/paged-gallery';
import type { MarkdownImageLook } from '@/components/markdown/markdown-image';
import { Icon } from '@/components/ui/icon';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Text } from '@/components/ui/text';
import { StarIcon } from '@/lib/icons';

import { cardBadgePlacement } from './card-badges';
import { badgeTone, GenuiImageGridContext, GenuiImageView } from './inline';
import { openGenuiLink } from './open-link';

export const kids = (value: unknown): GenuiNode[] => (Array.isArray(value) ? (value as GenuiNode[]) : []);

/** Phones are narrow: a Stack is always a column on mobile; StatRow handles its own grid. */
export function GenuiStack({ props, renderChild }: GenuiComponentProps) {
  const { t } = useTranslation();
  const children = kids(props.children);
  // Two or more images and nothing else read as one gallery, as on web: one page per image, swiped
  // sideways with native paging and a "2 / 5" counter under the page, as the markdown image gallery.
  // Every page keeps its caption.
  if (children.length > 1 && children.every((child) => child.type === 'Image')) {
    return (
      <PagedGallery
        count={children.length}
        accessibilityLabel={t('genui.imageCount', { defaultValue: '{{count}} images', count: children.length })}
        renderPage={(index, width) => (
          <View key={children[index].id} style={{ width }}>
            <GenuiImageGridContext.Provider value="page">{renderChild(children[index])}</GenuiImageGridContext.Provider>
          </View>
        )}
      />
    );
  }
  // Two or more Cards and nothing else read as one list or grid, as on web.
  if (children.length > 1 && children.every((child) => child.type === 'Card')) {
    return <GenuiCardList cards={children} layout={props.layout === 'list' || props.layout === 'grid' ? props.layout : undefined} />;
  }
  return <View className="gap-3">{children.map(renderChild)}</View>;
}

/** ★ 4.7 (33,899) · price, as web's CardRating: the rating in ink, the review count muted, the price after a separator. */
function CardRating({ rating, reviews, price }: { rating: unknown; reviews: unknown; price: unknown }) {
  const { i18n } = useTranslation();
  if (typeof rating !== 'number' && !price) return null;
  return (
    <View className="flex-row flex-wrap items-center gap-x-1.5">
      {typeof rating === 'number' ? (
        <View className="flex-row items-center gap-1">
          <Icon as={StarIcon} size={13} weight="fill" className="text-foreground" />
          <Text variant="small" className="leading-5 tabular-nums">
            {rating.toLocaleString(i18n.language, { maximumFractionDigits: 1 })}
          </Text>
          {typeof reviews === 'number' ? <Text variant="muted" className="tabular-nums">{`(${reviews.toLocaleString(i18n.language)})`}</Text> : null}
        </View>
      ) : null}
      {typeof rating === 'number' && price ? <Text variant="muted">·</Text> : null}
      {price ? (
        <Text variant="small" className="leading-5">
          {String(price)}
        </Text>
      ) : null}
    </View>
  );
}

/** One list badge: a pill a step off the card in both themes (secondary is too close to bg-card); a good pick leads with a gold star. */
function ListBadge({ badge }: { badge: GenuiNode }) {
  return (
    <View className="max-w-full shrink flex-row items-center gap-1.5 rounded-md bg-foreground/10 px-2 py-0.5">
      {badge.props.tone === 'good' ? <Icon as={StarIcon} size={12} weight="fill" className="text-kortix-yellow" /> : null}
      {/* One line at worst: a label wider than the card truncates instead of running past its edge. */}
      <Text numberOfLines={1} className="shrink text-xs leading-4 text-secondary-foreground">
        {String(badge.props.label)}
      </Text>
    </View>
  );
}

/**
 * A card's text in either layout, as web's CardText: the title (underlined when it links) with the badges top
 * right when they fit beside it (so a pick reads at a glance), else on their own line above it, so the title keeps
 * the full width (`cardBadgePlacement`); then rating, location line, and the description. `estimatedWidth` is the
 * column's width before it is measured, so the first frame already places the badges.
 */
function CardText({ props, estimatedWidth }: { props: GenuiNode['props']; estimatedWidth: number }) {
  const { fontScale } = useWindowDimensions();
  const [measured, setMeasured] = useState(0);
  const badges = kids(props.badges);
  const title = String(props.title);
  const placement = cardBadgePlacement({
    width: measured || estimatedWidth,
    title,
    badges: badges.map((badge) => ({ label: String(badge.props.label), star: badge.props.tone === 'good' })),
    fontScale,
  });
  const pills = badges.map((badge) => <ListBadge key={badge.id} badge={badge} />);
  const titleText = <Text className={`font-medium ${placement === 'beside' ? 'flex-1' : ''} ${props.href ? 'underline' : ''}`}>{title}</Text>;
  return (
    <View className="flex-1 gap-1" onLayout={(e) => setMeasured(Math.round(e.nativeEvent.layout.width))}>
      {badges.length > 0 && placement === 'above' ? (
        <>
          <View className="flex-row flex-wrap gap-1.5">{pills}</View>
          {titleText}
        </>
      ) : (
        <View className="flex-row items-baseline justify-between gap-3">
          {titleText}
          {badges.length > 0 ? <View className="max-w-[45%] shrink flex-row flex-wrap justify-end gap-1.5">{pills}</View> : null}
        </View>
      )}
      <CardRating rating={props.rating} reviews={props.reviews} price={props.price} />
      {/* Web's list subtitle: text-xs, muted. */}
      {props.subtitle ? <Text className="text-xs leading-4 text-muted-foreground">{String(props.subtitle)}</Text> : null}
      {props.body ? <Text variant="small" className="leading-5">{String(props.body)}</Text> : null}
    </View>
  );
}

/** The list thumbnail and the Steps photo: a 96pt square. A photo fills it; a logo sits whole inside a 6pt inset. */
export const THUMB = 96;
/** Below this width the grid is one column (every phone); a tablet gets two. */
const CARD_TWO_COLUMNS_MIN = 480;
/** The grid's gap between columns and an inset tile's padding, in pt. */
const GRID_GAP = 16;
const INSET_PAD = 24;
/** The transcript's side edge, and a list card's px-4 and its thumbnail gap (gap-3), in pt: the text column's estimate. */
const TRANSCRIPT_EDGE = 16;
const CARD_PAD_X = 16;
const CARD_ROW_GAP = 12;

/**
 * Two or more Cards, in web's two layouts (`cardListLayout`, shared with web): a grid of big images when
 * most images are photos, a list with small thumbnails for logos, icons, or no images. The model's
 * `layout` hint wins. Without one, the list shows first and switches once the photos load.
 */
function GenuiCardList({ cards, layout }: { cards: GenuiNode[]; layout?: 'list' | 'grid' }) {
  const screen = useWindowDimensions();
  const [width, setWidth] = useState(0);
  const [shapes, setShapes] = useState<Record<string, CardShape>>({});
  // Before the list is measured: the window less the transcript's 16pt edges.
  const listWidth = width || screen.width - 2 * TRANSCRIPT_EDGE;
  const mode = cardListLayout(layout, Object.values(shapes));
  const look = (id: string, extra: MarkdownImageLook = {}): MarkdownImageLook => ({
    ...extra,
    bare: true,
    onSize: (w, h) => {
      const shape = cardImageShape(w, h);
      setShapes((known) => (known[id]?.ratio === shape.ratio && known[id]?.fit === shape.fit ? known : { ...known, [id]: shape }));
    },
  });
  const open = (href: unknown) => (href ? () => openGenuiLink(href) : undefined);

  if (mode === 'list') {
    return (
      // Each option is its own card with a gap between, so the list reads as separate choices, not one block of text.
      <View className="gap-2" onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
        {cards.map(({ id, props }) => {
          const shape = shapes[id] ?? cardImageShape(0, 0);
          const image = props.image ? String(props.image) : null;
          return (
            <View key={id}>
              <Pressable
                accessibilityRole={props.href ? 'link' : undefined}
                disabled={!props.href}
                onPress={open(props.href)}
                className="flex-row gap-3 rounded-2xl bg-card px-4 py-3.5 active:opacity-70"
              >
                {image ? (
                  // The box keeps its size while the image loads and after it fails: the well, then the image icon.
                  <View style={{ width: THUMB, height: THUMB }} className={`overflow-hidden rounded-lg bg-secondary ${shape.inset ? 'p-1.5' : ''}`}>
                    <GenuiImageView
                      src={image}
                      alt=""
                      fixedHeight={shape.inset ? THUMB - 12 : THUMB}
                      look={look(id, { resizeMode: shape.inset ? 'contain' : 'cover', compact: true })}
                    />
                  </View>
                ) : null}
                <CardText props={props} estimatedWidth={listWidth - 2 * CARD_PAD_X - (image ? THUMB + CARD_ROW_GAP : 0)} />
              </Pressable>
            </View>
          );
        })}
      </View>
    );
  }

  const columns = width >= CARD_TWO_COLUMNS_MIN ? 2 : 1;
  const columnWidth = width > 0 ? (width - GRID_GAP * (columns - 1)) / columns : 0;
  const heights = cards.map(({ id, props }) => (props.image ? (shapes[id]?.ratio ?? UNKNOWN_RATIO) : 0) + CARD_TEXT_RATIO);
  return (
    <View onLayout={(e) => setWidth(e.nativeEvent.layout.width)} className="flex-row items-start" style={{ gap: GRID_GAP }}>
      {columnWidth > 0
        ? masonryColumns(heights, columns).map((column, c) => (
            <View key={c} className="flex-1 gap-5">
              {column.map((i) => {
                const { id, props } = cards[i]!;
                const shape = shapes[id] ?? cardImageShape(0, 0);
                const tile = Math.round(columnWidth * shape.ratio);
                return (
                  <Pressable key={id} accessibilityRole={props.href ? 'link' : undefined} disabled={!props.href} onPress={open(props.href)} className="gap-3 active:opacity-70">
                    {props.image ? (
                      <View style={{ height: tile, padding: shape.inset ? INSET_PAD : 0 }} className="overflow-hidden rounded-xl bg-secondary">
                        <GenuiImageView
                          src={String(props.image)}
                          alt=""
                          fixedHeight={shape.inset ? tile - 2 * INSET_PAD : tile}
                          look={look(id, { resizeMode: shape.fit, compact: true })}
                        />
                      </View>
                    ) : null}
                    <CardText props={props} estimatedWidth={columnWidth} />
                  </Pressable>
                );
              })}
            </View>
          ))
        : null}
    </View>
  );
}

/** A Card badge (web's Paper Card 07): a surface pill with a tone dot; the label stays ink. */
function CardBadge({ badge, well }: { badge: GenuiNode; well: string }) {
  return (
    <View className={`max-w-full shrink flex-row items-center gap-1.5 rounded-full px-2 py-0.5 ${well}`}>
      <View className={`size-1.5 rounded-full ${badgeTone(badge.props.tone).dot}`} />
      {/* One line at worst: a long label truncates inside the pill, never past the card. */}
      <Text variant="small" numberOfLines={1} className="shrink leading-5">
        {String(badge.props.label)}
      </Text>
    </View>
  );
}

/** The image well's height: the same box web's inset image well uses (h-40). */
const CARD_IMAGE_HEIGHT = 160;

export function GenuiCard({ props }: GenuiComponentProps) {
  const { fontScale, width: windowWidth } = useWindowDimensions();
  const [textWidth, setTextWidth] = useState(0);
  const badges = kids(props.badges);
  const image = Boolean(props.image);
  const subtitle = props.subtitle ? String(props.subtitle) : '';
  // The mono subtitle sits top right when it fits beside the title, as on web; a long one ("Colaba, South Mumbai")
  // takes its own line under the title instead of squeezing it (the badge rule, `cardBadgePlacement`).
  const subtitleBeside =
    !subtitle ||
    cardBadgePlacement({
      width: textWidth || windowWidth - 2 * TRANSCRIPT_EDGE - 2 * CARD_PAD_X,
      title: String(props.title),
      badges: [{ label: subtitle, star: false }],
      fontScale,
    }) === 'beside';
  const pills = (well: string) => badges.map((badge) => <CardBadge key={badge.id} badge={badge} well={well} />);
  const body = (
    // Paper Card 06, inset image well: a 6pt inset, so the image's radius nests inside the card's.
    <View className={`gap-3 rounded-2xl bg-card ${image ? 'p-1.5 pb-3.5' : 'px-4 py-3'}`}>
      {image ? (
        // A fixed box on the neutral well: the card keeps its height while the photo loads, and after it fails.
        <View style={{ height: CARD_IMAGE_HEIGHT }} className="overflow-hidden rounded-xl bg-secondary">
          {/* Decorative: the title below names the item. The photo fills the well, which is its frame: no outline. */}
          <GenuiImageView src={props.image} alt="" fixedHeight={CARD_IMAGE_HEIGHT} look={{ resizeMode: 'cover', bare: true, compact: true }} />
          {/* Both insets: the pills wrap inside the photo, never past its right edge. */}
          {badges.length > 0 ? <View className="absolute inset-x-2.5 top-2.5 flex-row flex-wrap gap-1.5">{pills('bg-background')}</View> : null}
        </View>
      ) : null}
      <View className={`gap-1 ${image ? 'px-2.5' : ''}`} onLayout={(e) => setTextWidth(Math.round(e.nativeEvent.layout.width))}>
        {subtitleBeside ? (
          <View className="flex-row items-baseline justify-between gap-3">
            <Text className={`flex-1 font-medium ${props.href ? 'underline' : ''}`}>{props.title}</Text>
            {subtitle ? <Text className="max-w-[45%] shrink text-right font-mono text-xs text-foreground">{subtitle}</Text> : null}
          </View>
        ) : (
          <>
            <Text className={`font-medium ${props.href ? 'underline' : ''}`}>{props.title}</Text>
            <Text className="font-mono text-xs text-foreground">{subtitle}</Text>
          </>
        )}
        <CardRating rating={props.rating} reviews={props.reviews} price={props.price} />
        {props.body ? <Text variant="muted">{props.body}</Text> : null}
        {/* Without an image the pills sit under the body, on the secondary well instead of the surface. */}
        {badges.length > 0 && !image ? <View className="flex-row flex-wrap gap-1.5 pt-1.5">{pills('bg-secondary')}</View> : null}
      </View>
    </View>
  );
  return props.href ? (
    <Pressable accessibilityRole="link" className="active:opacity-70" onPress={() => openGenuiLink(props.href)}>
      {body}
    </Pressable>
  ) : (
    body
  );
}

export function GenuiTabs({ props, renderChild, streaming }: GenuiComponentProps) {
  const tabs = kids(props.tabs);
  // A top-down stream mounts Tabs before its tabs exist, so the first tab is resolved at render, not at mount.
  const [value, setValue] = useState<string | null>(null);
  if (tabs.length === 0) return null;
  // While streaming, show the tab being written so progress is visible (spec §6.3).
  const active = streaming ? tabs.at(-1)!.id : tabs.some((tab) => tab.id === value) ? value! : tabs[0]!.id;
  return (
    <Tabs value={active} onValueChange={setValue}>
      {/* Up to 5 labels: they scroll sideways instead of squeezing on a narrow phone. */}
      <GHScrollView horizontal showsHorizontalScrollIndicator={false}>
        <TabsList>
          {tabs.map((tab) => (
            <TabsTrigger key={tab.id} value={tab.id}>
              <Text>{String(tab.props.label)}</Text>
            </TabsTrigger>
          ))}
        </TabsList>
      </GHScrollView>
      {tabs.map((tab) => (
        <TabsContent key={tab.id} value={tab.id}>
          <View className="gap-3 pt-1">{kids(tab.props.children).map(renderChild)}</View>
        </TabsContent>
      ))}
    </Tabs>
  );
}
