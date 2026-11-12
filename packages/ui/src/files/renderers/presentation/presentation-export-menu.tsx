'use client';

import {
  FileTextIcon as FileText,
  PresentationIcon as Presentation,
} from '@phosphor-icons/react';
import { useState } from 'react';
import type { useTranslations } from '../../../i18n';
import { Download } from '../../../internal/icons/download';
import { useDownloadRestriction } from '../../../internal/billing/use-download-restriction';
import { Button } from '../../../primitives/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../../../primitives/dropdown-menu';
import { KortixLoader } from '../../../primitives/kortix-loader';
import {
  DownloadFormat,
  downloadPresentation,
  sanitizeFilename,
} from './presentation-utils';

/** The `useTranslations` return for a namespace, as the viewer calls it. */
type Translator<NS extends string> = ReturnType<typeof useTranslations<NS>>;

/**
 * The export dropdown of the fullscreen viewer: the download restriction
 * check and the two download formats (PDF, PPTX).
 */
export function PresentationExportMenu({
  sandboxUrl,
  presentationName,
  tI18nComplete,
  tHardcodedUi,
}: {
  sandboxUrl?: string;
  presentationName?: string;
  tI18nComplete: Translator<'hardcodedUi.i18nComplete'>;
  tHardcodedUi: Translator<'hardcodedUi'>;
}) {
  // Download restriction for free tier users
  const { isRestricted: isDownloadRestricted, openUpgradeModal } = useDownloadRestriction({
    featureName: 'presentations',
  });
  const [isDownloadingPDF, setIsDownloadingPDF] = useState(false);
  const [isDownloadingPPTX, setIsDownloadingPPTX] = useState(false);

  const handleDownload = async (format: DownloadFormat) => {
    if (isDownloadRestricted) {
      openUpgradeModal();
      return;
    }
    if (!sandboxUrl || !presentationName) return;

    // Use sanitized name for the path (matching backend directory structure)
    const sanitizedName = sanitizeFilename(presentationName);

    const setDownloadState =
      format === DownloadFormat.PDF ? setIsDownloadingPDF : setIsDownloadingPPTX;

    setDownloadState(true);
    try {
      await downloadPresentation(
        format,
        sandboxUrl,
        `/workspace/presentations/${sanitizedName}`,
        presentationName,
        tI18nComplete,
      );
    } catch (error) {
      console.error(`Error downloading ${format}:`, error);
    } finally {
      setDownloadState(false);
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="w-8 p-0"
          title={tHardcodedUi.raw(
            'componentsThreadToolViewsPresentationToolsFullscreenpresentationviewer.line485JsxAttrTitleExportPresentation',
          )}
          disabled={isDownloadingPDF || isDownloadingPPTX}
        >
          {isDownloadingPDF || isDownloadingPPTX ? (
            <KortixLoader customSize={14} />
          ) : (
            <Download className="h-3.5 w-3.5" />
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-32">
        <DropdownMenuItem
          className="cursor-pointer"
          onClick={() => handleDownload(DownloadFormat.PDF)}
          disabled={isDownloadingPDF}
        >
          <FileText className="mr-2 h-4 w-4" />
          PDF
        </DropdownMenuItem>
        <DropdownMenuItem
          className="cursor-pointer"
          onClick={() => handleDownload(DownloadFormat.PPTX)}
          disabled={isDownloadingPPTX}
        >
          <Presentation className="mr-2 h-4 w-4" />
          PPTX
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
