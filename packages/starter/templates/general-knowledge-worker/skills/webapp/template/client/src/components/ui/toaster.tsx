import { Toast as ToastPrimitive } from "@base-ui/react/toast"

import { toastManager, type ToastData } from "@/hooks/use-toast"
import {
  Toast,
  ToastClose,
  ToastDescription,
  ToastProvider,
  ToastTitle,
  ToastViewport,
} from "@/components/ui/toast"

function ToastList() {
  const { toasts } = ToastPrimitive.useToastManager()

  return toasts.map((toast) => {
    const data = toast.data as ToastData | undefined
    return (
      <Toast key={toast.id} toast={toast} variant={data?.variant}>
        <div className="grid gap-1">
          {toast.title && <ToastTitle>{toast.title}</ToastTitle>}
          {toast.description && (
            <ToastDescription>{toast.description}</ToastDescription>
          )}
        </div>
        {data?.action}
        <ToastClose />
      </Toast>
    )
  })
}

export function Toaster() {
  return (
    <ToastProvider toastManager={toastManager} limit={1}>
      <ToastViewport>
        <ToastList />
      </ToastViewport>
    </ToastProvider>
  )
}
