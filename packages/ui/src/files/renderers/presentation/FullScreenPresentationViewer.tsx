import { Button } from '../../../primitives/button';
import { KortixLoader } from '../../../primitives/kortix-loader';
import { useTranslations } from '../../../i18n';
import { cn } from '../../../lib/utils';
import {
  CaretLeftIcon as ChevronLeft,
  CaretRightIcon as ChevronRight,
  PencilSimpleIcon as Edit,
  PresentationIcon as Presentation,
  SkipBackIcon as SkipBack,
  SkipForwardIcon as SkipForward,
  XIcon as X,
} from '@phosphor-icons/react';
import { useMemo, useState } from 'react';
import { PresentationExportMenu } from './presentation-export-menu';
import { SlideIframe } from './slide-iframe';
import { usePresentationMetadata } from './use-presentation-metadata';
import { useSlideNavigation } from './use-slide-navigation';

interface FullScreenPresentationViewerProps {
  isOpen: boolean;
  onClose: () => void;
  presentationName?: string;
  sandboxUrl?: string;
  initialSlide?: number;
}

/** The fullscreen presentation modal. The metadata lifecycle, the slide
 *  stage, the keyboard map and the export menu live in their own modules. */
export function FullScreenPresentationViewer({
  isOpen,
  onClose,
  presentationName,
  sandboxUrl,
  initialSlide = 1,
}: FullScreenPresentationViewerProps) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const tHardcodedUi = useTranslations('hardcodedUi');
  const [showEditor, setShowEditor] = useState(false);

  const { metadata, slides, isLoading, retryAttempt, subdomainOpts } = usePresentationMetadata({
    isOpen,
    presentationName,
    sandboxUrl,
    showEditor,
  });

  // Create a stable refresh timestamp when metadata changes (like PresentationViewer)
  const refreshTimestamp = useMemo(
    () => metadata?.updated_at || Date.now(),
    [metadata?.updated_at],
  );

  const totalSlides = slides.length;

  const { currentSlide, setCurrentSlide, goToNextSlide, goToPreviousSlide } = useSlideNavigation({
    isOpen,
    initialSlide,
    totalSlides,
    showEditor,
    onExitEditor: () => setShowEditor(false),
    onClose,
  });

  const currentSlideData = slides.find((slide) => slide.number === currentSlide);

  if (!isOpen) return null;

  // Render slide iframe with proper scaling
  const renderSlide =
    !currentSlideData || !sandboxUrl ? null : (
      <SlideIframe
        slide={currentSlideData}
        sandboxUrl={sandboxUrl}
        subdomainOpts={subdomainOpts}
        refreshTimestamp={refreshTimestamp}
        showEditor={showEditor}
        tI18nComplete={tI18nComplete}
        tHardcodedUi={tHardcodedUi}
      />
    );

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black/90 backdrop-blur-sm">
      {/* Top Controls Bar */}
      <div className="shrink-0 border-b border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
        <div
          className="kx-titlebar-row flex items-center justify-between p-4"
          data-sidebar-collapsed=""
        >
          <div className="flex items-center gap-3">
            <div className="relative shrink-0 rounded-2xl border border-zinc-300 bg-zinc-200/60 p-2 dark:border-zinc-700 dark:bg-zinc-900">
              <Presentation className="h-5 w-5 text-zinc-500 dark:text-zinc-400" />
            </div>

            {metadata && (
              <div>
                <h1 className="text-base font-medium text-zinc-900 dark:text-zinc-100">
                  {metadata.title || metadata.presentation_name}
                </h1>
                <p className="text-sm text-zinc-500 dark:text-zinc-400">
                  {tHardcodedUi.raw('i18nComplete.text6bb4c1177681')} {currentSlide}{' '}
                  {tHardcodedUi.raw('i18nComplete.text28391d3bc64e')} {totalSlides}
                </p>
              </div>
            )}
          </div>

          <div className="flex items-center gap-2">
            {/* Edit button */}
            <Button
              variant="ghost"
              size="sm"
              className="w-8 p-0"
              title={
                showEditor
                  ? tHardcodedUi.raw('i18nComplete.textbd0b7be215ce')
                  : tHardcodedUi.raw('i18nComplete.text8268dd9ea939')
              }
              onClick={() => setShowEditor(!showEditor)}
            >
              {showEditor ? (
                <Presentation className="h-3.5 w-3.5" />
              ) : (
                <Edit className="h-3.5 w-3.5" />
              )}
            </Button>

            {/* Export dropdown */}
            <PresentationExportMenu
              sandboxUrl={sandboxUrl}
              presentationName={presentationName}
              tI18nComplete={tI18nComplete}
              tHardcodedUi={tHardcodedUi}
            />

            {/* Close button */}
            <Button
              variant="ghost"
              size="sm"
              onClick={onClose}
              className="h-8 w-8 p-0"
              title={tHardcodedUi.raw(
                'componentsThreadToolViewsPresentationToolsFullscreenpresentationviewer.line529JsxAttrTitleCloseFullScreen',
              )}
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      </div>

      {/* Main Content Area */}
      <div className="flex min-h-0 flex-1 items-center justify-center bg-zinc-100 p-2 dark:bg-zinc-900">
        {isLoading || !currentSlideData ? (
          <div className="text-center">
            <KortixLoader size="large" className="mx-auto mb-4" />
            <p className="text-zinc-700 dark:text-zinc-300">
              {retryAttempt > 0
                ? tI18nComplete('text3df439a7a73b', { value0: retryAttempt + 1 })
                : tHardcodedUi.raw('i18nComplete.text1ac9fe8126fa')}
            </p>
          </div>
        ) : currentSlideData ? (
          <div className="flex h-full w-full flex-col">
            {/* Presentation Container */}
            <div
              className="flex-1 overflow-hidden rounded-xl bg-transparent"
              style={{ aspectRatio: '16 / 9' }}
            >
              {renderSlide}
            </div>

            {/* Controls below presentation */}
            <div className="mt-3 flex items-center justify-between px-4">
              {/* Left Controls */}
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setCurrentSlide(1)}
                  disabled={currentSlide <= 1}
                  className="h-8 w-8 p-0 disabled:opacity-50"
                >
                  <SkipBack className="h-3.5 w-3.5" />
                </Button>

                <Button
                  variant="ghost"
                  size="sm"
                  onClick={goToPreviousSlide}
                  disabled={currentSlide <= 1}
                  className="h-8 w-8 p-0 disabled:opacity-50"
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
              </div>

              {/* Center - Slide Indicators */}
              <div className="flex items-center">
                <div className="flex gap-2">
                  {slides.map((slide) => (
                    <button
                      key={slide.number}
                      aria-label={`${tHardcodedUi.raw('i18nComplete.text6bb4c1177681')} ${slide.number}`}
                      onClick={() => setCurrentSlide(slide.number)}
                      className={cn(
                        'h-2.5 w-2.5 rounded-full transition-colors duration-200',
                        slide.number === currentSlide
                          ? 'bg-black dark:bg-white'
                          : 'bg-zinc-300 hover:bg-zinc-400 dark:bg-zinc-600 dark:hover:bg-zinc-500',
                      )}
                    />
                  ))}
                </div>
              </div>

              {/* Right Controls */}
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={goToNextSlide}
                  disabled={currentSlide >= totalSlides}
                  className="h-8 w-8 p-0 disabled:opacity-50"
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>

                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setCurrentSlide(totalSlides)}
                  disabled={currentSlide >= totalSlides}
                  className="h-8 w-8 p-0 disabled:opacity-50"
                >
                  <SkipForward className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          </div>
        ) : (
          <div className="text-center">
            <p className="text-zinc-700 dark:text-zinc-300">
              {tHardcodedUi.raw(
                'componentsThreadToolViewsPresentationToolsFullscreenpresentationviewer.line621JsxTextNoSlideFound',
              )}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
