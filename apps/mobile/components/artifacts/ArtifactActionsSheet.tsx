/**
 * ArtifactActionsSheet — the "artifact ···" sheet: the viewer's `···` and a
 * long press on an Artifacts row open it.
 *
 * Layout = the session actions sheet (board 11b): the title row titled with the
 * artifact, one untitled group of Share link · Open in browser · Reload (viewer
 * only) · Pin or Unpin · Rename (`can_manage`), then Stop sharing alone in its
 * own group, destructive (`can_manage`). Rename pushes in place of the options
 * (`sheet-push`). Stop sharing confirms in a dialog that opens only after this
 * sheet has closed — never two overlays at once.
 *
 * Share sends `public_url` for a public artifact, else the app link
 * (`artifactShareUrl`), never the signed `view_url`. Open in browser opens the
 * signed page itself in the in-app browser: the app link there would ask the
 * viewer to sign in again, because the browser does not share the app's login.
 *
 * Stop sharing is web's "remove": the artifact leaves Artifacts and its links
 * stop working; its files stay in Files.
 *
 * Controlled by an imperative ref (`present(artifact)`): mount one instance.
 */
import * as React from 'react';
import { BackHandler, Keyboard, Platform, Share, View } from 'react-native';
import type { BottomSheetModal } from '@gorhom/bottom-sheet';
import { SheetScrollView } from '@/components/kortix/sheet-parts';
import Animated from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import type { Artifact, ArtifactDetail } from '@kortix/sdk';
import { useArtifactMutations } from '@kortix/sdk/react';

import { useConfirmDialog } from '@/components/kortix/confirm-dialog';
import { SettingsGroup, SettingsRow } from '@/components/kortix/settings-list';
import { KortixBottomSheetModal, useCloseThen } from '@/components/kortix/sheet';
import { POP_IN, PUSH_IN, SheetBackButton } from '@/components/kortix/sheet-push';
import { SheetTextInput } from '@/components/kortix/SheetInput';
import { useToast } from '@/components/kortix/toast-provider';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { artifactShareUrl } from '@/lib/artifacts/artifacts';
import { haptics } from '@/lib/haptics';
import {
  ArrowClockwiseIcon,
  ArrowSquareOutIcon,
  PencilSimpleIcon,
  PushPinIcon,
  PushPinSlashIcon,
  ShareNetworkIcon,
  XCircleIcon,
} from '@/lib/icons';
import { log } from '@/lib/logger';
import { openLink } from '@/lib/utils/open-link';
import { resolveLocalUrl } from '@/lib/utils/resolve-local-url';

const MAX_TITLE_LENGTH = 200;

export interface ArtifactActionsSheetRef {
  present: (artifact: Artifact | ArtifactDetail) => void;
}

interface ArtifactActionsSheetProps {
  projectId: string;
  /** Shows Reload: the viewer passes it, the list does not. */
  onReload?: () => void;
  /** The artifact stopped being shared: the viewer closes. */
  onRemoved?: (artifactId: string) => void;
  /** Open over another sheet (the viewer), so the viewer stays under it. */
  pushed?: boolean;
}

type SheetView = 'options' | 'rename';

export const ArtifactActionsSheet = React.forwardRef<ArtifactActionsSheetRef, ArtifactActionsSheetProps>(
  function ArtifactActionsSheet({ projectId, onReload, onRemoved, pushed = false }, ref) {
    const { t } = useTranslation();
    const toast = useToast();
    const insets = useSafeAreaInsets();
    const sheetRef = React.useRef<BottomSheetModal>(null);
    const mutations = useArtifactMutations(projectId);
    const { confirm, dialog } = useConfirmDialog();
    const { deferAfterClose, takeAfterClose, clearAfterClose } = useCloseThen<() => void>();

    const [artifact, setArtifact] = React.useState<Artifact | ArtifactDetail | null>(null);
    const [view, setView] = React.useState<SheetView>('options');
    const [returning, setReturning] = React.useState(false);
    const [name, setName] = React.useState('');
    const [open, setOpen] = React.useState(false);

    React.useImperativeHandle(
      ref,
      () => ({
        present: (next) => {
          haptics.medium();
          clearAfterClose();
          setArtifact(next);
          setView('options');
          setReturning(false);
          setOpen(true);
          sheetRef.current?.present();
        },
      }),
      [clearAfterClose],
    );

    const closeSheet = React.useCallback(() => sheetRef.current?.dismiss(), []);

    // Rename reads at full height, clear of the keyboard; Back returns to the
    // options at their content height (the session actions sheet's rule).
    const openRename = React.useCallback(() => {
      haptics.tap();
      setReturning(false);
      setView('rename');
      sheetRef.current?.snapToPosition('100%');
    }, []);
    const backToOptions = React.useCallback(() => {
      haptics.tap();
      setReturning(true);
      setView('options');
      sheetRef.current?.snapToIndex(0);
    }, []);

    // Android back: Rename goes back to the options, the options close the
    // sheet. Registered while open, so it runs before the viewer's and the
    // project stack's handlers (the newest handler runs first).
    React.useEffect(() => {
      if (Platform.OS !== 'android' || !open) return undefined;
      const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
        if (view === 'rename') backToOptions();
        else closeSheet();
        return true;
      });
      return () => subscription.remove();
    }, [backToOptions, closeSheet, open, view]);
    const closeThen = React.useCallback(
      (next: () => void) => {
        deferAfterClose(next);
        sheetRef.current?.dismiss();
      },
      [deferAfterClose],
    );

    const share = React.useCallback(() => {
      if (!artifact) return;
      const url = artifactShareUrl(artifact);
      closeThen(() => {
        // iOS shares a URL; Android's share sheet takes text.
        Share.share(Platform.OS === 'ios' ? { url } : { message: url }).catch((error) =>
          log.warn('[ArtifactActionsSheet] Share failed:', error),
        );
      });
    }, [artifact, closeThen]);

    const openInBrowser = React.useCallback(() => {
      if (!artifact) return;
      const url = resolveLocalUrl('version' in artifact ? artifact.version.view_url : artifact.view_url);
      closeThen(() => {
        openLink(url).catch(() => toast.error(t('artifacts.openError')));
      });
    }, [artifact, closeThen, t, toast]);

    const togglePin = React.useCallback(() => {
      if (!artifact) return;
      const pinned = !artifact.pinned;
      haptics.tap();
      closeSheet();
      mutations.pin.mutate(
        { artifactId: artifact.artifact_id, pinned },
        {
          onSuccess: () => toast.success(t(pinned ? 'artifacts.pinDone' : 'artifacts.unpinDone')),
          onError: () => {
            haptics.warning();
            toast.error(t('artifacts.actionFailed'));
          },
        },
      );
    }, [artifact, closeSheet, mutations.pin, t, toast]);

    const startRename = React.useCallback(() => {
      if (!artifact) return;
      setName(artifact.title);
      openRename();
    }, [artifact, openRename]);

    const saveRename = React.useCallback(() => {
      if (!artifact || mutations.update.isPending) return;
      const title = name.trim();
      if (!title || title === artifact.title) {
        closeSheet();
        return;
      }
      Keyboard.dismiss();
      mutations.update.mutate(
        { artifactId: artifact.artifact_id, title },
        {
          onSuccess: () => {
            haptics.success();
            toast.success(t('artifacts.renamed'));
            closeSheet();
          },
          onError: () => {
            haptics.warning();
            toast.error(t('artifacts.actionFailed'));
          },
        },
      );
    }, [artifact, closeSheet, mutations.update, name, t, toast]);

    const stopSharing = React.useCallback(() => {
      if (!artifact) return;
      const target = artifact;
      haptics.warning();
      closeThen(() =>
        confirm({
          title: t('artifacts.removeTitle'),
          description: t('artifacts.removeHint'),
          confirmLabel: t('artifacts.remove'),
          cancelLabel: t('artifacts.cancel'),
          destructive: true,
          onConfirm: () =>
            mutations.remove.mutate(target.artifact_id, {
              onSuccess: () => {
                haptics.success();
                toast.success(t('artifacts.removed'));
                onRemoved?.(target.artifact_id);
              },
              onError: () => {
                haptics.warning();
                toast.error(t('artifacts.actionFailed'));
              },
            }),
        }),
      );
    }, [artifact, closeThen, confirm, mutations.remove, onRemoved, t, toast]);

    const reload = React.useCallback(() => {
      if (!onReload) return;
      haptics.tap();
      closeThen(onReload);
    }, [closeThen, onReload]);

    return (
      <>
        <KortixBottomSheetModal
          ref={sheetRef}
          title={view === 'rename' ? t('artifacts.rename') : (artifact?.title ?? t('artifacts.title'))}
          titleLeading={
            view === 'rename' ? (
              <SheetBackButton onPress={backToOptions} />
            ) : undefined
          }
          {...(pushed ? { stackBehavior: 'push' as const } : null)}
          enableDynamicSizing
          enablePanDownToClose
          keyboardBehavior="interactive"
          keyboardBlurBehavior="restore"
          onDismiss={() => {
            setOpen(false);
            setView('options');
            takeAfterClose()?.();
          }}>
          <SheetScrollView
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 16) + 8 }}>
            {!artifact ? null : view === 'options' ? (
              <Animated.View key="options" entering={returning ? POP_IN : undefined}>
                <View className="px-4" style={{ gap: 18 }}>
                  <SettingsGroup>
                    <SettingsRow icon={ShareNetworkIcon} label={t('artifacts.shareLink')} right={null} onPress={share} />
                    <SettingsRow
                      icon={ArrowSquareOutIcon}
                      label={t('artifacts.openInBrowser')}
                      right={null}
                      onPress={openInBrowser}
                    />
                    {onReload ? (
                      <SettingsRow icon={ArrowClockwiseIcon} label={t('artifacts.reload')} right={null} onPress={reload} />
                    ) : null}
                    <SettingsRow
                      icon={artifact.pinned ? PushPinSlashIcon : PushPinIcon}
                      label={t(artifact.pinned ? 'artifacts.unpin' : 'artifacts.pin')}
                      right={null}
                      onPress={togglePin}
                    />
                    {artifact.can_manage ? (
                      <SettingsRow icon={PencilSimpleIcon} label={t('artifacts.rename')} onPress={startRename} />
                    ) : null}
                  </SettingsGroup>
                  {artifact.can_manage ? (
                    <SettingsGroup>
                      <SettingsRow
                        icon={XCircleIcon}
                        label={t('artifacts.remove')}
                        destructive
                        right={null}
                        onPress={stopSharing}
                      />
                    </SettingsGroup>
                  ) : null}
                </View>
              </Animated.View>
            ) : (
              <Animated.View key="rename" entering={PUSH_IN}>
                <View className="gap-4 px-4">
                  <SheetTextInput
                    value={name}
                    onChangeText={setName}
                    placeholder={t('artifacts.namePlaceholder')}
                    accessibilityLabel={t('artifacts.namePlaceholder')}
                    autoFocus
                    maxLength={MAX_TITLE_LENGTH}
                    returnKeyType="done"
                    onSubmitEditing={saveRename}
                  />
                  <Button
                    size="lg"
                    className="rounded-full"
                    disabled={mutations.update.isPending || !name.trim()}
                    onPress={saveRename}>
                    <Text>{mutations.update.isPending ? t('artifacts.saving') : t('artifacts.save')}</Text>
                  </Button>
                </View>
              </Animated.View>
            )}
          </SheetScrollView>
        </KortixBottomSheetModal>
        {dialog}
      </>
    );
  },
);
