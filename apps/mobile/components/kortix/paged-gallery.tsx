/**
 * The paged image gallery the markdown and genui images share: several images
 * in a row, one per page, swiped sideways with native paging (each swipe snaps
 * to the next image), and a "2 / 5" counter under the page.
 */
import type React from 'react';
import { useCallback, useState } from 'react';
import {
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  ScrollView,
  View,
} from 'react-native';

import { Text } from '@/components/ui/text';

/** Every gallery page is this tall; each image fits inside it. */
export const GALLERY_PAGE_HEIGHT = 280;

/**
 * One pager: `count` pages (whatever `renderPage` draws for each index), the
 * swipe state and the counter. `placeholder` shows while the pager has no width
 * yet; default: an empty page-height view, as the genui gallery.
 */
export function PagedGallery({
  count,
  accessibilityLabel,
  placeholder,
  renderPage,
}: {
  count: number;
  accessibilityLabel: string;
  placeholder?: React.ReactNode;
  renderPage: (index: number, width: number) => React.ReactNode;
}) {
  const [width, setWidth] = useState(0);
  const [page, setPage] = useState(0);
  const onLayout = useCallback((e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width), []);
  const onScrollEnd = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      if (width > 0) setPage(Math.round(e.nativeEvent.contentOffset.x / width));
    },
    [width],
  );
  return (
    <View onLayout={onLayout} accessibilityLabel={accessibilityLabel}>
      {width > 0 ? (
        <ScrollView
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          decelerationRate="fast"
          onMomentumScrollEnd={onScrollEnd}
        >
          {Array.from({ length: count }, (_, index) => renderPage(index, width))}
        </ScrollView>
      ) : (
        (placeholder ?? <View style={{ height: GALLERY_PAGE_HEIGHT }} />)
      )}
      <Text variant="muted" className="mt-2 self-end tabular-nums">
        {`${page + 1} / ${count}`}
      </Text>
    </View>
  );
}
