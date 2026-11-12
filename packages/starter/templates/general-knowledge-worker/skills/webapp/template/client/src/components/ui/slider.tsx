"use client"

import * as React from "react"
import { Slider as SliderPrimitive } from "@base-ui/react/slider"

import { cn } from "@/lib/utils"

/** `value` / `defaultValue` take a number, or an array for a range. */
function Slider({
  className,
  defaultValue,
  value,
  ...props
}: SliderPrimitive.Root.Props) {
  const values = Array.isArray(value ?? defaultValue)
    ? ((value ?? defaultValue) as readonly number[])
    : [0]

  return (
    <SliderPrimitive.Root
      data-slot="slider"
      className={cn("relative w-full touch-none select-none", className)}
      defaultValue={defaultValue}
      value={value}
      {...props}
    >
      <SliderPrimitive.Control className="relative flex w-full items-center py-2">
        <SliderPrimitive.Track className="relative h-2 w-full grow overflow-hidden rounded-full bg-secondary">
          <SliderPrimitive.Indicator className="absolute h-full bg-primary" />
        </SliderPrimitive.Track>
        {values.map((_, index) => (
          <SliderPrimitive.Thumb
            key={index}
            index={index}
            className="block h-5 w-5 rounded-full border-2 border-primary bg-background ring-offset-background transition-colors has-[:focus-visible]:outline-none has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring has-[:focus-visible]:ring-offset-2 data-[disabled]:pointer-events-none data-[disabled]:opacity-50"
          />
        ))}
      </SliderPrimitive.Control>
    </SliderPrimitive.Root>
  )
}

export { Slider }
