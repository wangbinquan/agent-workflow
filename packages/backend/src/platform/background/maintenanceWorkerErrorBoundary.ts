interface MaintenanceWorkerErrorTarget {
  addEventListener(type: 'error', listener: (event: ErrorEvent) => void): void
  addEventListener(
    type: 'unhandledrejection',
    listener: (event: MaintenanceWorkerRejectionEvent) => void,
  ): void
}

export interface MaintenanceWorkerRejectionEvent {
  readonly reason: unknown
  preventDefault(): void
}

export interface MaintenanceWorkerErrorBoundaryOptions {
  readonly target: MaintenanceWorkerErrorTarget
  readonly onFatal: (error: string) => void
  /** Test seam; production defers until the cancelable error event has returned. */
  readonly defer?: (notify: () => void) => void
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message || error.name
  if (typeof error === 'string' && error !== '') return error
  try {
    const encoded = JSON.stringify(error)
    if (encoded !== undefined && encoded !== '') return encoded
  } catch {
    // Fall through to the stable protocol-level fallback.
  }
  return 'maintenance worker error'
}

/**
 * Keep a Worker-local async failure inside the maintenance failure domain.
 *
 * Bun 1.3 can propagate an uncaught Worker error into the owning process even
 * when the parent has an `onerror` observer. Cancel it at the originating
 * global scope, then notify the parent on the next task so it can drain and
 * replace this generation from the durable lease/cursor without racing the
 * cancelable event dispatch itself.
 */
export function installMaintenanceWorkerErrorBoundary(
  options: MaintenanceWorkerErrorBoundaryOptions,
): void {
  const defer = options.defer ?? ((notify) => setTimeout(notify, 0))
  let notified = false
  const contain = (event: { preventDefault(): void }, error: unknown): void => {
    event.preventDefault()
    if (notified) return
    notified = true
    const message = messageOf(error)
    defer(() => options.onFatal(message))
  }

  options.target.addEventListener('error', (event) => {
    contain(event, event.error ?? event.message)
  })
  options.target.addEventListener('unhandledrejection', (event) => {
    contain(event, event.reason)
  })
}
