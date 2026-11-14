"use client";

import { AnimatePresence, m } from "motion/react";
import { useReducedMotion } from "./internal/hooks/use-reduced-motion";
import type { ReactNode } from "react";

export function AnimatedCopyIcon({
  copied,
  children,
}: {
  copied: boolean;
  children: ReactNode;
}) {
  const reducedMotion = useReducedMotion();
  if (reducedMotion)
    return (
      <span className="absolute inset-0 inline-flex items-center justify-center">
        {children}
      </span>
    );
  return (
    <AnimatePresence initial={false} mode="popLayout">
      <m.span
        key={copied ? "check" : "copy"}
        initial={{ scale: 0.25, opacity: 0, filter: "blur(4px)" }}
        animate={{ scale: 1, opacity: 1, filter: "blur(0px)" }}
        exit={{ scale: 0.25, opacity: 0, filter: "blur(4px)" }}
        transition={{ type: "spring", duration: 0.3, bounce: 0 }}
        className="absolute inset-0 inline-flex items-center justify-center"
      >
        {children}
      </m.span>
    </AnimatePresence>
  );
}
