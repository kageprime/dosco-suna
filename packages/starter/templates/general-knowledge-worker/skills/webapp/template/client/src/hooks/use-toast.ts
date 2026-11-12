import * as React from "react"
import { Toast as ToastPrimitive } from "@base-ui/react/toast"

import type { ToastActionElement, ToastProps } from "@/components/ui/toast"

/** The one toast queue. `<Toaster />` renders it; `toast()` adds to it. */
export const toastManager = ToastPrimitive.createToastManager()

export type ToastData = {
  variant?: ToastProps["variant"]
  action?: ToastActionElement
}

type Toast = ToastProps & {
  title?: React.ReactNode
  description?: React.ReactNode
  action?: ToastActionElement
  /** Milliseconds before it closes by itself. `0` keeps it open. Default 5000. */
  duration?: number
}

function options({ title, description, action, variant, duration }: Toast) {
  return {
    title,
    description,
    timeout: duration,
    data: { variant, action } satisfies ToastData,
  }
}

function toast(props: Toast) {
  const id = toastManager.add(options(props))
  return {
    id,
    dismiss: () => toastManager.close(id),
    update: (next: Toast) => toastManager.update(id, options(next)),
  }
}

function useToast() {
  return {
    toast,
    dismiss: (toastId?: string) => toastManager.close(toastId),
  }
}

export { useToast, toast }
