import type { BackgroundExecutionLifetime } from '@/platform/background/definitions'

export interface EventCenterWorkerDependencies {
  readonly waitForWake?: (intervalMs: number, signal: AbortSignal) => Promise<void>
  runOnePublication?(): Promise<'completed' | 'retried' | 'dead-letter' | 'idle'>
  runOneDueObserver(): Promise<'completed' | 'failed' | 'obsolete' | 'idle'>
  runOneNotification(): Promise<'completed' | 'retried' | 'dead-letter' | 'idle'>
}

export interface EventCenterCycleResult {
  readonly steps: number
  readonly observerRuns: number
  readonly publicationRuns: number
  readonly notificationDeliveries: number
  readonly madeProgress: boolean
}

/** Global bounded driver; consumers acknowledge independent fan-out deliveries. */
export async function runEventCenterCycle(
  deps: EventCenterWorkerDependencies,
  maxSteps = 32,
  execution?: BackgroundExecutionLifetime,
): Promise<EventCenterCycleResult> {
  const current = execution?.current.bind(execution)
  if (!Number.isSafeInteger(maxSteps) || maxSteps <= 0) {
    throw new Error('event center worker maxSteps must be a positive integer')
  }
  let observerRuns = 0
  let publicationRuns = 0
  let notificationDeliveries = 0
  let steps = 0
  for (; steps < maxSteps; steps += 1) {
    if (current?.() === false) break
    let progressed = false
    const publication = (await deps.runOnePublication?.()) ?? 'idle'
    if (publication !== 'idle') {
      publicationRuns += 1
      progressed = true
    }
    if (current?.() === false) break
    const observer = await deps.runOneDueObserver()
    if (observer !== 'idle') {
      observerRuns += 1
      progressed = true
    }
    if (current?.() === false) break
    const notification = await deps.runOneNotification()
    if (notification !== 'idle') {
      notificationDeliveries += 1
      progressed = true
    }
    if (!progressed) break
  }
  return {
    steps,
    publicationRuns,
    observerRuns,
    notificationDeliveries,
    madeProgress: publicationRuns + observerRuns + notificationDeliveries > 0,
  }
}

export function startEventCenterWorker(input: {
  readonly dependencies: EventCenterWorkerDependencies
  readonly intervalMs: number
  readonly onError: (error: unknown) => void
  readonly onCycle?: (result: EventCenterCycleResult) => void
}): { readonly stop: () => void; readonly runNow: () => Promise<void> } {
  let running = false
  let stopped = false
  const runNow = async (): Promise<void> => {
    if (running || stopped) return
    running = true
    try {
      input.onCycle?.(await runEventCenterCycle(input.dependencies))
    } catch (error) {
      input.onError(error)
    } finally {
      running = false
    }
  }
  const timer = setInterval(() => void runNow(), input.intervalMs)
  timer.unref?.()
  void runNow()
  return {
    stop() {
      stopped = true
      clearInterval(timer)
    },
    runNow,
  }
}
