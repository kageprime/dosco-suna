'use client';

import { buildStaticFilePreviewUrl as constructHtmlPreviewUrl } from '@kortix/sdk';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSandboxProxy } from '../../../internal/hooks/use-sandbox-proxy';
import { sanitizeFilename } from './presentation-utils';

export interface SlideMetadata {
  title: string;
  filename: string;
  file_path: string;
  preview_url: string;
  created_at: string;
}

export interface PresentationMetadata {
  presentation_name: string;
  title: string;
  description: string;
  slides: Record<string, SlideMetadata>;
  created_at: string;
  updated_at: string;
}

/**
 * The fullscreen viewer's metadata lifecycle: the fetch (with cache busting),
 * its unbounded retry with exponential backoff, the reload when the modal
 * opens and when the editor closes, and the cleanup of a pending retry.
 */
export function usePresentationMetadata({
  isOpen,
  presentationName,
  sandboxUrl,
  showEditor,
}: {
  isOpen: boolean;
  presentationName?: string;
  sandboxUrl?: string;
  showEditor: boolean;
}) {
  const { subdomainOpts } = useSandboxProxy();
  const [metadata, setMetadata] = useState<PresentationMetadata | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [retryAttempt, setRetryAttempt] = useState(0);
  const retryTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const hasLoadedRef = useRef(false);

  // Track the previous isOpen state to detect when modal opens
  const wasOpenRef = useRef(false);

  // Load metadata with retry logic
  const loadMetadata = useCallback(
    async (retryCount = 0, maxRetries = Infinity) => {
      // Don't load if we already successfully loaded metadata
      if (hasLoadedRef.current) {
        return;
      }

      // If sandbox URL isn't available yet, wait and don't set loading state
      if (!presentationName || !sandboxUrl) {
        setIsLoading(false);
        return;
      }

      setIsLoading(true);
      setRetryAttempt(retryCount);

      try {
        // Sanitize the presentation name to match backend directory creation
        const sanitizedPresentationName = sanitizeFilename(presentationName);

        const metadataUrl = constructHtmlPreviewUrl(
          `presentations/${sanitizedPresentationName}/metadata.json`,
          subdomainOpts,
        );

        const urlWithCacheBust = `${metadataUrl}?t=${Date.now()}`;
        console.log(`Loading presentation metadata (attempt ${retryCount + 1}):`, urlWithCacheBust);

        const response = await fetch(urlWithCacheBust, {
          cache: 'no-cache',
          headers: { 'Cache-Control': 'no-cache' },
        });

        if (response.ok) {
          const data = await response.json();
          setMetadata(data);
          hasLoadedRef.current = true; // Mark as successfully loaded
          console.log('Successfully loaded presentation metadata:', data);
          setIsLoading(false);

          // Clear any pending retry timeout on success
          if (retryTimeoutRef.current) {
            clearTimeout(retryTimeoutRef.current);
            retryTimeoutRef.current = null;
          }

          return; // Success, exit early
        } else {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
      } catch (err) {
        console.error(`Error loading metadata (attempt ${retryCount + 1}):`, err);

        // Calculate delay with exponential backoff, capped at 10 seconds
        // For early attempts, use shorter delays. After 5 attempts, use consistent 5 second intervals
        const delay =
          retryCount < 5
            ? Math.min(1000 * Math.pow(2, retryCount), 10000) // Exponential backoff for first 5 attempts
            : 5000; // Consistent 5 second intervals after that

        console.log(`Retrying in ${delay}ms... (attempt ${retryCount + 1})`);

        // Keep retrying indefinitely - don't set error state
        retryTimeoutRef.current = setTimeout(() => {
          loadMetadata(retryCount + 1, maxRetries);
        }, delay);

        return; // Keep loading state, don't set error
      }
    },
    [presentationName, sandboxUrl, subdomainOpts],
  );

  // Sync metadata with the modal state: an open resets the loaded flag and
  // starts (or restarts) the load, a close stops a pending retry.
  useEffect(() => {
    const justOpened = isOpen && !wasOpenRef.current;
    wasOpenRef.current = isOpen;

    if (justOpened) {
      // Reset loaded flag when opening (so we can reload if needed)
      hasLoadedRef.current = false;

      // Clear any existing retry timeout when opening
      if (retryTimeoutRef.current) {
        clearTimeout(retryTimeoutRef.current);
        retryTimeoutRef.current = null;
      }

      // Only start loading if we have the required data
      if (presentationName && sandboxUrl) {
        loadMetadata();
      } else {
        setIsLoading(false);
      }
    } else if (!isOpen) {
      // Clear retry timeout when closing
      if (retryTimeoutRef.current) {
        clearTimeout(retryTimeoutRef.current);
        retryTimeoutRef.current = null;
      }
    }
  }, [isOpen, presentationName, sandboxUrl, loadMetadata]);

  // Cleanup retry timeout on unmount
  useEffect(() => {
    return () => {
      if (retryTimeoutRef.current) {
        clearTimeout(retryTimeoutRef.current);
      }
    };
  }, []);

  // The slide list, ordered by slide number, as the pager and the stage read it
  const slides = metadata
    ? Object.entries(metadata.slides)
        .map(([num, slide]) => ({ number: parseInt(num), ...slide }))
        .sort((a, b) => a.number - b.number)
    : [];

  // Reload metadata when exiting editor mode to refresh with latest changes
  useEffect(() => {
    let timeoutId: NodeJS.Timeout;

    if (!showEditor && isOpen) {
      // Reset loaded flag so we can reload after editor changes
      hasLoadedRef.current = false;

      // Add a small delay to allow the editor to save changes
      timeoutId = setTimeout(() => {
        loadMetadata();
      }, 300);
    }

    return () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showEditor, isOpen]);

  return { metadata, slides, isLoading, retryAttempt, subdomainOpts };
}
