'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Which slide is showing and how it changes: the initial-slide sync on open,
 * the pager transitions, and the fullscreen keyboard map.
 */
export function useSlideNavigation({
  isOpen,
  initialSlide,
  totalSlides,
  showEditor,
  onExitEditor,
  onClose,
}: {
  isOpen: boolean;
  initialSlide: number;
  totalSlides: number;
  showEditor: boolean;
  onExitEditor: () => void;
  onClose: () => void;
}) {
  const [currentSlide, setCurrentSlide] = useState(initialSlide);

  // Track the previous isOpen state to detect when modal opens
  const wasOpenRef = useRef(false);

  // Sync currentSlide with initialSlide when modal opens (not on every initialSlide change)
  useEffect(() => {
    const justOpened = isOpen && !wasOpenRef.current;
    wasOpenRef.current = isOpen;

    if (justOpened) {
      // Modal just opened - set the slide to the requested initial slide
      setCurrentSlide(initialSlide);
    }
  }, [isOpen, initialSlide]);

  // Navigation functions
  const goToNextSlide = useCallback(() => {
    if (currentSlide < totalSlides) {
      setCurrentSlide((prev) => prev + 1);
    }
  }, [currentSlide, totalSlides]);

  const goToPreviousSlide = useCallback(() => {
    if (currentSlide > 1) {
      setCurrentSlide((prev) => prev - 1);
    }
  }, [currentSlide]);

  // Keyboard navigation
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // Prevent default for all our handled keys
      const handledKeys = [
        'ArrowLeft',
        'ArrowRight',
        'ArrowUp',
        'ArrowDown',
        ' ',
        'Home',
        'End',
        'Escape',
      ];
      if (handledKeys.includes(e.key)) {
        e.preventDefault();
        e.stopPropagation();
      }

      switch (e.key) {
        case 'ArrowLeft':
        case 'ArrowUp':
          goToPreviousSlide();
          break;
        case 'ArrowRight':
        case 'ArrowDown':
        case ' ':
          goToNextSlide();
          break;
        case 'Home':
          setCurrentSlide(1);
          break;
        case 'End':
          setCurrentSlide(totalSlides);
          break;
        case 'Escape':
          if (showEditor) {
            onExitEditor();
          } else {
            onClose();
          }
          break;
      }
    };

    // Add event listener to document with capture to ensure we get the events first
    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [isOpen, goToNextSlide, goToPreviousSlide, totalSlides, onClose, showEditor, onExitEditor]);

  return { currentSlide, setCurrentSlide, goToNextSlide, goToPreviousSlide };
}
