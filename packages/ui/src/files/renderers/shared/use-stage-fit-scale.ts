import { useLayoutEffect, useState } from 'react';

/**
 * Scales a fixed-size stage to fit the element this is bound to, keeping the
 * stage's aspect ratio: the smaller of the width and height ratios (width
 * only, when the stage has no fixed height), capped at 1 unless
 * `allowUpscale` is set.
 */
export function fitScale(
  containerWidth: number,
  containerHeight: number,
  stageWidth: number,
  stageHeight: number | undefined,
  allowUpscale: boolean,
): number {
  // Calculate scale to fit the stage into the container while maintaining
  // aspect ratio
  const scale =
    stageHeight === undefined
      ? containerWidth / stageWidth
      : Math.min(containerWidth / stageWidth, containerHeight / stageHeight);
  return allowUpscale ? scale : Math.min(1, scale);
}

/**
 * Scales the fixed-size stage down to fit a narrower viewport — never up,
 * unless `allowUpscale` is set (the presentation slide follows its container
 * in both directions; the pptx desktop stage only shrinks).
 * Uses a callback ref (rather than a plain `useRef`) so the observer
 * attaches exactly when the viewport element mounts — it doesn't exist yet on
 * first render, since the viewer only appears once the file bytes finish
 * loading.
 */
export function useStageFitScale(
  stageWidth: number,
  stageHeight: number | undefined,
  options: { allowUpscale: boolean },
): [(node: HTMLDivElement | null) => void, number] {
  const { allowUpscale } = options;
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(1);

  useLayoutEffect(() => {
    if (!node || typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? node.clientWidth;
      const height =
        stageHeight === undefined ? undefined : (entries[0]?.contentRect.height ?? node.clientHeight);
      setScale(fitScale(width, height ?? 0, stageWidth, stageHeight, allowUpscale));
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [node, stageWidth, stageHeight, allowUpscale]);

  return [setNode, scale];
}
