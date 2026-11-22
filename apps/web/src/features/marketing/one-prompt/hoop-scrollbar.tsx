'use client';

import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';

import { HOOP_PALETTE } from './hoop-palette';

const IDLE_MS = 900;
const EDGE_PX = 16;

/** A viewport scrollbar that keeps window scrolling, anchors and the sticky header intact. */
export function HoopScrollbar() {
  const [metrics, setMetrics] = useState({ height: 0, thumb: 0, top: 0, max: 0, position: 0 });
  const drag = useRef<{ pointerId: number; offset: number } | null>(null);

  const [visible, setVisible] = useState(false);
  const edgeHovered = useRef(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activity = useCallback((reveal = true) => {
    if (reveal) setVisible(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => {
      if (!drag.current && !edgeHovered.current) setVisible(false);
    }, IDLE_MS);
  }, []);

  useEffect(() => {
    const onScroll = () => activity();
    const onPointerMove = (event: globalThis.PointerEvent) => {
      const nearEdge = event.pointerType !== 'touch' && event.clientX >= document.documentElement.clientWidth - EDGE_PX && event.clientX <= document.documentElement.clientWidth && event.clientY >= 0 && event.clientY <= document.documentElement.clientHeight;
      if (nearEdge === edgeHovered.current) return;
      edgeHovered.current = nearEdge;
      activity(nearEdge);
    };
    const leaveEdge = () => {
      edgeHovered.current = false;
      activity(false);
    };
    const onPointerOut = (event: globalThis.PointerEvent) => {
      if (!event.relatedTarget) leaveEdge();
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('pointermove', onPointerMove, { passive: true });
    window.addEventListener('pointerout', onPointerOut);
    window.addEventListener('blur', leaveEdge);
    return () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerout', onPointerOut);
      window.removeEventListener('blur', leaveEdge);
    };
  }, [activity]);

  useEffect(() => {
    let frame = 0;
    const measure = () => {
      frame = 0;
      const root = document.documentElement;
      const height = root.clientHeight;
      const max = Math.max(0, root.scrollHeight - height);
      const thumb = Math.min(height, Math.max(32, height * height / root.scrollHeight));
      const position = Math.max(0, Math.min(max, window.scrollY));
      setMetrics({ height, thumb, max, position, top: max ? position / max * (height - thumb) : 0 });
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(document.body);
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    measure();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
    };
  }, []);

  const scrollToPointer = (y: number) => {
    const { height, thumb, max } = metrics;
    const travel = height - thumb;
    if (travel > 0) window.scrollTo({ top: Math.max(0, Math.min(1, (y - (drag.current?.offset ?? thumb / 2)) / travel)) * max, behavior: 'instant' });
  };
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || drag.current) return;
    event.preventDefault();
    activity();
    event.currentTarget.blur();
    const { top, thumb } = metrics;
    drag.current = { pointerId: event.pointerId, offset: event.clientY >= top && event.clientY <= top + thumb ? event.clientY - top : thumb / 2 };
    event.currentTarget.setPointerCapture(event.pointerId);
    scrollToPointer(event.clientY);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const { position, height, max } = metrics;
    const next = {
      ArrowDown: position + 40,
      ArrowUp: position - 40,
      PageDown: position + height * 0.9,
      PageUp: position - height * 0.9,
      Home: 0,
      End: max,
      ' ': position + height * 0.9 * (event.shiftKey ? -1 : 1),
    }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    window.scrollTo({ top: Math.max(0, Math.min(max, next)), behavior: 'instant' });
  };

  if (!metrics.max) return null;
  return (
    <>
      <style jsx global>{`
        html:has([data-loop-scrollbar]) { scrollbar-width: none; }
        html:has([data-loop-scrollbar])::-webkit-scrollbar { display: none; }
        @media (forced-colors: active) {
          [data-loop-scrollbar] { background: Canvas; }
          [data-loop-scrollbar-thumb] { background: CanvasText !important; }
        }
      `}</style>
      <div
        data-loop-scrollbar
        data-visible={visible || undefined}
        role="scrollbar"
        aria-label="Page scroll"
        aria-controls="loopmaxxing-content"
        aria-orientation="vertical"
        aria-valuemin={0}
        aria-valuemax={Math.round(metrics.max)}
        aria-valuenow={Math.round(metrics.position)}
        tabIndex={0}
        className="focus-visible:outline-ring pointer-events-none fixed inset-y-0 right-0 z-40 w-3 touch-none cursor-pointer opacity-0 transition-opacity duration-fast select-none data-visible:pointer-events-auto data-visible:opacity-100 data-visible:transition-none focus-visible:pointer-events-auto focus-visible:opacity-100 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:transition-none motion-reduce:transition-none"
        onFocus={() => activity()}
        onBlur={() => activity(false)}
        onPointerDown={onPointerDown}
        onPointerMove={(event) => { if (drag.current?.pointerId === event.pointerId) scrollToPointer(event.clientY); }}
        onPointerUp={(event) => {
          if (drag.current?.pointerId !== event.pointerId) return;
          drag.current = null;
          activity(false);
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={(event) => { if (drag.current?.pointerId === event.pointerId) { drag.current = null; activity(false); } }}
        onLostPointerCapture={(event) => { if (drag.current?.pointerId === event.pointerId) { drag.current = null; activity(false); } }}
        onKeyDown={onKeyDown}
      >
        <div
          data-loop-scrollbar-thumb
          className="pointer-events-none absolute right-[3px] w-1.5 rounded-full"
          style={{
            height: metrics.thumb,
            transform: `translateY(${metrics.top}px)`,
            background: `linear-gradient(to bottom, ${HOOP_PALETTE[0]} 0% 25%, ${HOOP_PALETTE[3]} 25% 50%, ${HOOP_PALETTE[1]} 50% 75%, ${HOOP_PALETTE[2]} 75% 100%)`,
          }}
        />
      </div>
    </>
  );
}
