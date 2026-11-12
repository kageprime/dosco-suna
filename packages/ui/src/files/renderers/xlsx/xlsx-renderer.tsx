'use client';

import { FileXlsIcon as FileSpreadsheet } from '@phosphor-icons/react';
import { useTranslations } from '../../../i18n';
import { useIsDark } from '../../../hooks/use-is-dark';
import { cn } from '../../../lib/utils';
import { XlsxViewerPreview } from './xlsx-viewer';

interface XlsxRendererProps {
  /** The workbook bytes. The parent owns the read (useBinaryBlob), like it
   *  does for the docx and pptx viewers — this renderer never reads a path. */
  blob?: Blob | null;
  fileName: string;
  /** Extra controls for the viewer's own toolbar, rendered after zoom and
   *  before the file menu. */
  compact?: boolean;
  toolbarActions?: React.ReactNode;
  className?: string;
  /** False when the host's own toolbar already has the Download button, so the
   *  viewer does not show a second one. */
  showDownload?: boolean;
}

export function XlsxRenderer({
  blob,
  fileName,
  className,
  compact = false,
  toolbarActions,
  showDownload = true,
}: XlsxRendererProps) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const isDark = useIsDark();

  if (!blob) {
    return (
      <div className={cn('flex h-full w-full items-center justify-center', className)}>
        <div className="space-y-3 text-center">
          <div className="bg-muted mx-auto flex h-16 w-16 items-center justify-center rounded-full">
            <FileSpreadsheet className="text-muted-foreground h-8 w-8" />
          </div>
          <div>
            <h3 className="text-foreground text-lg font-medium">
              {tI18nComplete.raw('text29f7878c46b4')}
            </h3>
          </div>
        </div>
      </div>
    );
  }

  return (
    <XlsxViewerPreview
      workbook={blob}
      fileName={fileName}
      isDark={isDark}
      onIsDarkChange={() => {}}
      showToolbar={!compact}
      showDownload={showDownload}
      showUpload={false}
      className={cn('h-full w-full', className)}
      toolbarActions={toolbarActions}
    />
  );
}
