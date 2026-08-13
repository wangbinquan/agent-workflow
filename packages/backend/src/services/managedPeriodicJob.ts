import { JS_TIMER_MAX_MS } from '@agent-workflow/shared'

export interface PeriodicTimerApi<Handle = ReturnType<typeof setTimeout>> {
  setTimeout: (callback: () => void, delayMs: number) => Handle
  clearTimeout: (handle: Handle) => void
  unref?: (handle: Handle) => void
}

const nativeTimerApi: PeriodicTimerApi = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle),
  unref: (handle) => (handle as { unref?: () => void }).unref?.(),
}

export interface ManagedPeriodicJobOptions<Handle = ReturnType<typeof setTimeout>> {
  run: () => Promise<void> | void
  timerApi?: PeriodicTimerApi<Handle>
  minPositiveMs?: number
  onInvalid?: (delayMs: unknown) => void
  onError?: (error: unknown) => void
}

export interface ManagedPeriodicJobHandle {
  reconfigure: (delayMs: unknown) => boolean
  stop: () => void
}

/** Non-overlapping periodic job whose cadence can be changed after Config save. */
export function createManagedPeriodicJob<Handle = ReturnType<typeof setTimeout>>(
  opts: ManagedPeriodicJobOptions<Handle>,
): ManagedPeriodicJobHandle {
  const timers = opts.timerApi ?? (nativeTimerApi as unknown as PeriodicTimerApi<Handle>)
  let generation = 0
  let running = false
  let enabled = false
  let delayMs: number | null = null
  let timer: Handle | null = null
  let pendingRearm = false

  const clearArmed = (): void => {
    if (timer === null) return
    timers.clearTimeout(timer)
    timer = null
  }

  const arm = (ownerGeneration: number): void => {
    if (!enabled || delayMs === null || timer !== null || ownerGeneration !== generation) return
    timer = timers.setTimeout(() => {
      timer = null
      if (!enabled || ownerGeneration !== generation) return
      if (running) {
        pendingRearm = true
        return
      }
      running = true
      void Promise.resolve()
        .then(opts.run)
        .catch((error) => opts.onError?.(error))
        .finally(() => {
          running = false
          if (!enabled || timer !== null) return
          if (pendingRearm || ownerGeneration === generation) {
            pendingRearm = false
            arm(generation)
          }
        })
    }, delayMs)
    timers.unref?.(timer)
  }

  return {
    reconfigure: (nextDelayMs) => {
      generation += 1
      clearArmed()
      pendingRearm = false
      const minPositiveMs = opts.minPositiveMs ?? 1
      if (
        typeof nextDelayMs !== 'number' ||
        !Number.isSafeInteger(nextDelayMs) ||
        (nextDelayMs !== 0 && (nextDelayMs < minPositiveMs || nextDelayMs > JS_TIMER_MAX_MS))
      ) {
        enabled = false
        delayMs = null
        opts.onInvalid?.(nextDelayMs)
        return false
      }
      delayMs = nextDelayMs
      enabled = delayMs > 0
      if (running && enabled) pendingRearm = true
      arm(generation)
      return true
    },
    stop: () => {
      generation += 1
      enabled = false
      delayMs = null
      pendingRearm = false
      clearArmed()
    },
  }
}
