/**
 * The places of a Map as rows: with the map switched off, and when the basemap fails. Each row is web's
 * `PlaceCard` (`map-canvas.tsx`): the place's photo, its name, its facts (`value · kind`, e.g. the rating or price
 * in its pin and what it is), its note, and the actions: Directions, then Website and Call when the place has
 * them. The full-screen map's place panel (`map-sheet.tsx`) shows the same row as a card.
 */
import { safeUrl } from '@kortix/sdk/genui';
import { Fragment } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Text } from '@/components/ui/text';
import { telLink, type MapPlace, type PlaceAction } from '@/lib/genui/map-geo';

import { GenuiImageView } from '../components/inline';
import { openPlaceAction } from '../components/open-link';

/** The place photo: 64pt, as web's `size-16`. */
const PHOTO = 64;

/** web `PlaceCard`'s facts line: the pin's figure (a rating, a price) and the place's kind. */
export function placeFacts(place: Pick<MapPlace, 'value' | 'kind'>): string {
  return [place.value, place.kind].filter(Boolean).join(' · ');
}

/**
 * One place: name, note, actions. `onSelect` makes the name and note a button (the full-screen panel: it shows the
 * place on the map). `compact` holds the name to one line and the note to two, so the panel's cards share a height.
 */
export function PlaceRow({ place, onSelect, compact = false }: { place: MapPlace; onSelect?: () => void; compact?: boolean }) {
  const { t } = useTranslation();
  const facts = placeFacts(place);
  const image = safeUrl(place.image);
  const action = (kind: PlaceAction, label: string) => (
    <Button
      size="sm"
      variant={kind === 'directions' ? 'default' : 'secondary'}
      className="flex-1 rounded-full"
      accessibilityLabel={`${label}: ${place.label}`}
      onPress={() => openPlaceAction(place, kind)}
    >
      <Text numberOfLines={1}>{label}</Text>
    </Button>
  );
  return (
    <View className={`gap-3 px-4 py-3 ${compact ? 'flex-1 justify-between' : ''}`}>
      <Pressable
        disabled={!onSelect}
        onPress={onSelect}
        accessibilityRole={onSelect ? 'button' : undefined}
        accessibilityLabel={onSelect ? `${t('genui.showOnMap', 'Show on map')}: ${place.label}` : undefined}
        className="flex-row gap-3 active:opacity-70"
      >
        {image ? (
          // A fixed box on the neutral well: the card keeps its height while the photo loads or fails.
          <View style={{ width: PHOTO, height: PHOTO }} className="overflow-hidden rounded-lg bg-secondary">
            <GenuiImageView src={image} alt="" fixedHeight={PHOTO} look={{ bare: true, resizeMode: 'cover', compact: true }} />
          </View>
        ) : null}
        <View className="min-w-0 flex-1 gap-0.5">
          <Text className="font-medium" numberOfLines={compact ? 1 : undefined}>
            {place.label}
          </Text>
          {facts ? (
            <Text variant="small" className="leading-5" numberOfLines={1} style={{ fontVariant: ['tabular-nums'] }}>
              {facts}
            </Text>
          ) : null}
          {place.description ? (
            <Text variant="muted" numberOfLines={compact ? 2 : undefined}>
              {place.description}
            </Text>
          ) : null}
        </View>
      </Pressable>
      <View className="flex-row gap-2">
        {action('directions', t('genui.directions', 'Directions'))}
        {safeUrl(place.href) ? action('website', t('genui.website', 'Website')) : null}
        {telLink(place.phone) ? action('call', t('genui.call', 'Call')) : null}
      </View>
    </View>
  );
}

export function GenuiPlaceList({ places }: { places: MapPlace[] }) {
  const { t } = useTranslation();
  // Every marker dropped (off the globe): web keeps the empty card; here the card says so instead of
  // collapsing the block the pending box held.
  if (!places.length) {
    return (
      <View className="rounded-2xl bg-card px-4 py-3">
        <Text variant="muted">{t('genui.mapUnavailable', 'Map unavailable')}</Text>
      </View>
    );
  }
  return (
    <View className="rounded-2xl bg-card">
      {places.map((place, i) => (
        <Fragment key={place.id}>
          {i > 0 ? <Separator /> : null}
          <PlaceRow place={place} />
        </Fragment>
      ))}
    </View>
  );
}
