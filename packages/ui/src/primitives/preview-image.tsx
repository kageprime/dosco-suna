'use client';

import { Dialog as DialogPrimitive } from '@base-ui/react/dialog';
import * as React from 'react';

import { Close } from '../icons/close';
import { VisuallyHidden } from '../lib/base-ui-compat';
import { cn } from '../lib/utils';
import { Button } from './button';
import { DialogClose, DialogPopup, DialogPortal, DialogTrigger, type DialogContentBaseProps } from './dialog';

/** The image preview root. It sits outside the dialog layer stack: its content carries its own z-index. */
function PreviewImage({
  open,
  defaultOpen,
  onOpenChange,
  modal,
  children,
}: {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  modal?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <DialogPrimitive.Root
      open={open}
      defaultOpen={defaultOpen}
      onOpenChange={onOpenChange ? (next) => onOpenChange(next) : undefined}
      modal={modal}
    >
      {children}
    </DialogPrimitive.Root>
  );
}

const PreviewImageTrigger = DialogTrigger;

const PreviewImagePortal = DialogPortal;

const PreviewImageClose = DialogClose;

const PreviewImageOverlay = React.forwardRef<HTMLDivElement, React.ComponentPropsWithoutRef<'div'>>(
  ({ className, ...props }, ref) => (
    <DialogPrimitive.Backdrop
      ref={ref}
      className={cn('fixed inset-0 z-50 bg-black/40', className)}
      {...props}
    />
  ),
);
PreviewImageOverlay.displayName = 'PreviewImageOverlay';

interface PreviewImageContentProps extends DialogContentBaseProps {
  fileContent?: string;
  fileName?: string;
  fullscreen?: boolean;
}

const MIN_ZOOM = 0.7;
const DEFAULT_ZOOM = 1;
const MAX_ZOOM = 2;
const ZOOM_STEP = 0.1;
const DEFAULT_ORIGIN = '50% 50%';

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const PreviewImageContent = React.forwardRef<HTMLDivElement, PreviewImageContentProps>(({ className, fileContent, fileName, ...props }, ref) => {
  const [zoomLevel, setZoomLevel] = React.useState(DEFAULT_ZOOM);
  const [transformOrigin, setTransformOrigin] = React.useState(DEFAULT_ORIGIN);

  const [zoomedContent, setZoomedContent] = React.useState(fileContent);
  if (fileContent !== zoomedContent) {
    setZoomedContent(fileContent);
    setZoomLevel(DEFAULT_ZOOM);
    setTransformOrigin(DEFAULT_ORIGIN);
  }

  const getTransformOrigin = (
    event: React.MouseEvent<HTMLDivElement> | React.WheelEvent<HTMLDivElement>,
  ) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (!rect.width || !rect.height) {
      return DEFAULT_ORIGIN;
    }

    const x = ((event.clientX - rect.left) / rect.width) * 100;
    const y = ((event.clientY - rect.top) / rect.height) * 100;
    const xPercent = clamp(x, 0, 100);
    const yPercent = clamp(y, 0, 100);

    return `${xPercent}% ${yPercent}%`;
  };

  const handleWheelZoom = (event: React.WheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    setTransformOrigin(getTransformOrigin(event));
    setZoomLevel((currentZoom) => {
      const nextZoom = event.deltaY < 0 ? currentZoom + ZOOM_STEP : currentZoom - ZOOM_STEP;
      return clamp(Number(nextZoom.toFixed(1)), MIN_ZOOM, MAX_ZOOM);
    });
  };

  const handleImageClick = (event: React.MouseEvent<HTMLDivElement>) => {
    setTransformOrigin(getTransformOrigin(event));
    setZoomLevel((currentZoom) => (currentZoom > DEFAULT_ZOOM ? DEFAULT_ZOOM : MAX_ZOOM));
  };

  return (
    <PreviewImagePortal>
      <PreviewImageOverlay />
      <DialogPopup
        ref={ref}
        className={cn(
          'fixed top-[50%] left-[50%] z-[99999] grid h-full w-full -translate-x-1/2 -translate-y-1/2 items-center justify-center gap-4 shadow-lg duration-moderate sm:rounded-lg',
          className,
        )}
        {...props}
      >
        <VisuallyHidden>
          <DialogPrimitive.Title>Image preview</DialogPrimitive.Title>
        </VisuallyHidden>

        <div
          className="absolute top-3 right-3 z-[60] flex gap-1"
          onClick={(event) => event.stopPropagation()}
        >
          <PreviewImageClose asChild>
            <Button
              size="icon"
              type="button"
              aria-label="Close image preview"
              className="text-background"
            >
              <Close className="size-4" />
            </Button>
          </PreviewImageClose>
        </div>

        <div
          className="flex h-full max-h-[100vh] w-[100vw] items-center justify-center overflow-auto"
          onWheel={handleWheelZoom}
          onClick={handleImageClick}
        >
          <div
            className={cn(zoomLevel > DEFAULT_ZOOM ? 'cursor-zoom-out' : 'cursor-zoom-in')}
            style={{
              transform: `scale(${zoomLevel})`,
              transformOrigin,
              transition: 'transform 200ms',
            }}
          >
            {fileContent ? (
              <img
                src={fileContent}
                alt={fileName || 'Image preview'}
                width={1920}
                height={1080}
                className="max-h-[100vh] w-auto object-contain"
              />
            ) : null}
          </div>
        </div>
      </DialogPopup>
    </PreviewImagePortal>
  );
});
PreviewImageContent.displayName = 'PreviewImageContent';

export {
  PreviewImage,
  PreviewImageClose,
  PreviewImageContent,
  PreviewImageOverlay,
  PreviewImagePortal,
  PreviewImageTrigger,
};
