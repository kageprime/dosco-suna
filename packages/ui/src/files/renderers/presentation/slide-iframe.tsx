'use client';

import { buildStaticFilePreviewUrl as constructHtmlPreviewUrl } from '@kortix/sdk';
import { PresentationIcon as Presentation } from '@phosphor-icons/react';
import { memo } from 'react';
import type { useTranslations } from '../../../i18n';
import { framePolicy } from '../../viewer/preview-policy';
import { useStageFitScale } from '../shared/use-stage-fit-scale';
import type { SlideMetadata } from './use-presentation-metadata';

/** The `useTranslations` return for a namespace, as the viewer calls it. */
type Translator<NS extends string> = ReturnType<typeof useTranslations<NS>>;

interface SlideIframeProps {
  slide: SlideMetadata & { number: number };
  sandboxUrl?: string;
  subdomainOpts: Parameters<typeof constructHtmlPreviewUrl>[1];
  refreshTimestamp: string | number;
  showEditor: boolean;
  tI18nComplete: Translator<'hardcodedUi.i18nComplete'>;
  tHardcodedUi: Translator<'hardcodedUi'>;
}

/**
 * The slide stage: the sandbox iframe with its sandbox policy, and the
 * fit-scale of the 1920x1080 stage inside its 16:9 container (upscale
 * allowed — the stage follows the container in both directions).
 */
export const SlideIframe = memo(
  ({
    slide,
    sandboxUrl,
    subdomainOpts,
    refreshTimestamp,
    showEditor,
    tI18nComplete,
    tHardcodedUi,
  }: SlideIframeProps) => {
    const [containerRef, scale] = useStageFitScale(1920, 1080, { allowUpscale: true });

    if (!sandboxUrl) {
      return (
        <div className="flex h-full items-center justify-center">
          <div className="text-center">
            <Presentation className="mx-auto mb-4 h-12 w-12 text-zinc-400" />
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              {tHardcodedUi.raw(
                'componentsThreadToolViewsPresentationToolsFullscreenpresentationviewer.line377JsxTextNoSlideContentToPreview',
              )}
            </p>
          </div>
        </div>
      );
    }

    const slideUrl = constructHtmlPreviewUrl(slide.file_path, subdomainOpts);
    // Add cache-busting to iframe src to ensure fresh content
    const slideUrlWithCacheBust = `${slideUrl}?t=${refreshTimestamp}`;
    const frameSrc = showEditor
      ? `${sandboxUrl}/api/html/${slide.file_path}/editor`
      : slideUrlWithCacheBust;

    return (
      <div className="flex h-full w-full items-center justify-center bg-transparent">
        <div
          ref={containerRef}
          className="relative overflow-hidden rounded-lg bg-transparent"
          style={{
            width: '100%',
            maxWidth: '100%',
            aspectRatio: '16 / 9',
            maxHeight: '100%',
            containIntrinsicSize: '1920px 1080px',
            contain: 'layout style',
          }}
        >
          <iframe
            key={`slide-${slide.number}-${refreshTimestamp}-${showEditor}`} // Key with stable timestamp ensures iframe refreshes when metadata changes
            src={frameSrc}
            title={tI18nComplete('text871475cb411c', {
              value0: slide.number,
              value1: slide.title,
            })}
            className="rounded-xl border-0"
            // Agent-written slides keep same-origin only on a preview origin
            // of their own, never on this app's or the API's origin.
            sandbox={framePolicy('slide', frameSrc).sandbox}
            style={{
              width: '1920px',
              height: '1080px',
              border: 'none',
              display: 'block',
              transform: `scale(${scale})`,
              transformOrigin: '0 0',
              position: 'absolute',
              top: 0,
              left: `calc((100% - ${1920 * scale}px) / 2)`,
              backfaceVisibility: 'hidden',
              WebkitBackfaceVisibility: 'hidden',
            }}
          />
        </div>
      </div>
    );
  },
  (prevProps, nextProps) => {
    // Custom comparison function - only re-render if slide number or file_path changes
    // (extended with the now-explicit stage props; the iframe element itself
    // remounts only through its key).
    return (
      prevProps.slide.number === nextProps.slide.number &&
      prevProps.slide.file_path === nextProps.slide.file_path &&
      prevProps.sandboxUrl === nextProps.sandboxUrl &&
      prevProps.subdomainOpts === nextProps.subdomainOpts &&
      prevProps.refreshTimestamp === nextProps.refreshTimestamp &&
      prevProps.showEditor === nextProps.showEditor
    );
  },
);

SlideIframe.displayName = 'SlideIframe';
