/**
 * ArtifactsPage (`/projects/[id]/artifacts`) — the project's artifacts: the
 * docs and pages agents and people shared, web's Artifacts gallery as a list.
 *
 * Layout (the Sessions page's): `PageHeader` with the hamburger, the search
 * field (server-side `q`, debounced 250 ms: the list returns at most 100 rows,
 * so search is the way past them; on iOS at the bottom, `BottomSearchBar
 * fieldAtRest` as on Apps: the full field at rest, an X while it is focused), the scope chips All · Yours · Shared with
 * you · Pinned, then one plain row per artifact: type glyph · title · how long
 * ago it changed. No live thumbnails: one WebView only, in the viewer.
 *
 * A tap opens the viewer sheet over this page (`ArtifactViewerSheet`); a long
 * press opens the actions sheet. A project whose platform stores no Drive has
 * no Artifacts: the drawer hides the row, and a direct open says so.
 */

import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { Artifact, ArtifactListScope } from '@kortix/sdk';
import { useArtifacts, useFeatureFlag } from '@kortix/sdk/react';

import { ArtifactActionsSheet, type ArtifactActionsSheetRef } from '@/components/artifacts/ArtifactActionsSheet';
import { PageContent } from '@/components/kortix/page-content';
import { PageHeader } from '@/components/kortix/page-header';
import { PageList } from '@/components/kortix/page-list';
import { SearchListHeader } from '@/components/kortix/search-list-header';
import { BottomSearchBar, useBottomSearchInset, usesBottomSearch } from '@/components/kortix/bottom-search-bar';
import { SettingsGroupItem, SettingsRow } from '@/components/kortix/settings-list';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { ARTIFACT_SCOPES, artifactsEmptyState } from '@/lib/artifacts/artifacts';
import { haptics } from '@/lib/haptics';
import { BrowserIcon, FileTextIcon } from '@/lib/icons';
import { formatRelativeTime } from '@/lib/ui/format';
import { useDebouncedValue } from '@/lib/ui/use-debounced-value';
import { THEME } from '@/lib/utils/theme';
import { useTone } from '@/lib/utils/tone';
import { useArtifactViewerStore } from '@/stores/artifact-viewer-store';

const SEARCH_DEBOUNCE_MS = 250;

interface ArtifactsPageProps {
  projectId: string;
  onOpenDrawer?: () => void;
}

export function ArtifactsPage({ projectId, onOpenDrawer }: ArtifactsPageProps) {
  const { t } = useTranslation();
  const background = THEME[useTone()].background;
  const actionsRef = React.useRef<ArtifactActionsSheetRef>(null);
  const bottomSearch = usesBottomSearch();
  const bottomInset = useBottomSearchInset();

  const [query, setQuery] = React.useState('');
  const [scope, setScope] = React.useState<ArtifactListScope>('all');
  const debouncedQuery = useDebouncedValue(query.trim(), SEARCH_DEBOUNCE_MS);

  // Fails closed while the project row loads: no request before the answer.
  const availability = useFeatureFlag(projectId, 'artifacts');
  const available = availability.enabled;
  const list = useArtifacts(available ? projectId : null, {
    scope,
    ...(debouncedQuery ? { q: debouncedQuery } : {}),
  });
  const rows = list.data ?? [];

  const open = React.useCallback(
    (artifact: Artifact) => {
      haptics.tap();
      useArtifactViewerStore.getState().open({ projectId, artifactId: artifact.artifact_id, title: artifact.title });
    },
    [projectId],
  );
  const openActions = React.useCallback((artifact: Artifact) => actionsRef.current?.present(artifact), []);

  const empty = artifactsEmptyState({ query: debouncedQuery, scope });
  const emptyLabel = !available
    ? availability.isLoading
      ? null
      : t('artifacts.unavailable')
    : rows.length === 0 && !list.isPending && !list.isFetching
      ? empty === 'no-match'
        ? t('artifacts.emptyFiltered')
        : empty === 'scope-empty'
          ? t('artifacts.scopeEmpty')
          : t('artifacts.empty')
      : null;

  return (
    <View style={{ flex: 1, backgroundColor: background }}>
      <PageHeader title={t('artifacts.title')} onOpenDrawer={onOpenDrawer} />

      <PageContent>
        {available ? (
          <>
            {bottomSearch ? null : (
              <SearchListHeader
                value={query}
                onChangeText={setQuery}
                placeholder={t('artifacts.search')}
                inputProps={{ accessibilityLabel: t('artifacts.search'), returnKeyType: 'search' }}
              />
            )}
            {/* Scrolls sideways: "Shared with you" is long in fr, es and pt. */}
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              className="grow-0 pb-2"
              contentContainerClassName="gap-2 px-4"
              accessibilityRole="tablist">
              {ARTIFACT_SCOPES.map((value) => (
                <Button
                  key={value}
                  variant={scope === value ? 'secondary' : 'ghost'}
                  size="sm"
                  className="rounded-full"
                  onPress={() => {
                    haptics.selection();
                    setScope(value);
                  }}
                  accessibilityRole="tab"
                  accessibilityState={{ selected: scope === value }}>
                  <Text>{t(`artifacts.scope.${value}`)}</Text>
                </Button>
              ))}
            </ScrollView>
          </>
        ) : null}

        <PageList<Artifact>
          // `isPending`, not `isLoading`: offline, a paused first read is not an empty list.
          isLoading={availability.isLoading || (available && list.isPending)}
          errorMessage={available && list.isError && rows.length === 0 ? t('artifacts.loadError') : null}
          onRetry={() => void list.refetch()}
          onRefresh={available ? () => list.refetch() : undefined}
          emptyLabel={emptyLabel}
          header={<View className="h-1" />}
          bottomInset={bottomSearch && available ? bottomInset : undefined}
          data={available ? rows : []}
          keyExtractor={(artifact) => artifact.artifact_id}
          renderItem={(artifact, index) => (
            <View className="px-4">
              <SettingsGroupItem index={index} count={rows.length}>
                <SettingsRow
                  icon={artifact.type === 'doc' ? FileTextIcon : BrowserIcon}
                  label={artifact.title}
                  value={formatRelativeTime(artifact.updated_at)}
                  onPress={() => open(artifact)}
                  onLongPress={() => openActions(artifact)}
                  longPressLabel={t('artifacts.more')}
                  accessibilityLabel={`${artifact.title}, ${t(`artifacts.type.${artifact.type}`)}`}
                />
              </SettingsGroupItem>
            </View>
          )}
        />
      </PageContent>

      {available ? (
        <BottomSearchBar
          value={query}
          onChangeText={setQuery}
          placeholder={t('artifacts.search')}
          searchLabel={t('artifacts.search')}
          fieldAtRest
          background={background}
        />
      ) : null}

      <ArtifactActionsSheet ref={actionsRef} projectId={projectId} />
    </View>
  );
}
