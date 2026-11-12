import * as React from "react"

import { cn } from "@/lib/utils"

/** A box with a fixed width-to-height ratio, e.g. `ratio={16 / 9}`. */
function AspectRatio({
  ratio = 1,
  className,
  style,
  ...props
}: React.ComponentProps<"div"> & { ratio?: number }) {
  return (
    <div
      data-slot="aspect-ratio"
      className={cn("relative w-full", className)}
      style={{ aspectRatio: ratio, ...style }}
      {...props}
    />
  )
}

export { AspectRatio }
