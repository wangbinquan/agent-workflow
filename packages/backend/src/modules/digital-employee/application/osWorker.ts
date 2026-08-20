/**
 * Bounded driver for the stateful Digital Employee OS.
 *
 * Every operation owns its durable lease/outbox state. This loop only gives
 * those owners turns; it never carries business state in memory and never
 * chooses the next work item. A daemon restart therefore resumes from the
 * stores instead of from a timer callback.
 */

export interface DigitalEmployeeOsWorkerDependencies {
  readonly eventCenter: {
    runOneDueObserver(): Promise<'completed' | 'failed' | 'obsolete' | 'idle'>
  }
  readonly runtime: {
    runOneOutbox(): Promise<'completed' | 'retried' | 'idle'>
    pumpOneDelivery(): boolean
    planOneReaction(): string | null
    inspectOneExecution(): Promise<'completed' | 'retried' | 'failed' | 'pending' | 'idle'>
    publishOneChannelResult(): 'completed' | 'idle'
  }
}

export interface DigitalEmployeeOsCycleResult {
  readonly steps: number
  readonly observerRuns: number
  readonly deliveries: number
  readonly plannedRounds: number
  readonly outboxSettlements: number
  readonly executionSettlements: number
  readonly channelResults: number
  readonly madeProgress: boolean
}

export async function runDigitalEmployeeOsCycle(
  deps: DigitalEmployeeOsWorkerDependencies,
  maxSteps = 32,
): Promise<DigitalEmployeeOsCycleResult> {
  if (!Number.isSafeInteger(maxSteps) || maxSteps <= 0) {
    throw new Error('digital employee worker maxSteps must be a positive integer')
  }
  let observerRuns = 0
  let deliveries = 0
  let plannedRounds = 0
  let outboxSettlements = 0
  let executionSettlements = 0
  let channelResults = 0
  let steps = 0
  for (; steps < maxSteps; steps += 1) {
    let progressed = false
    const observation = await deps.eventCenter.runOneDueObserver()
    if (observation !== 'idle') {
      observerRuns += 1
      progressed = true
    }

    if (deps.runtime.publishOneChannelResult() === 'completed') {
      channelResults += 1
      progressed = true
    }

    if (deps.runtime.pumpOneDelivery()) {
      deliveries += 1
      progressed = true
    }

    if (deps.runtime.planOneReaction() !== null) {
      plannedRounds += 1
      progressed = true
    }

    const outbox = await deps.runtime.runOneOutbox()
    if (outbox !== 'idle') {
      outboxSettlements += 1
      progressed = true
    }

    const execution = await deps.runtime.inspectOneExecution()
    if (execution === 'completed' || execution === 'retried' || execution === 'failed') {
      executionSettlements += 1
      progressed = true
    }
    if (!progressed) break
  }
  return {
    steps,
    observerRuns,
    deliveries,
    plannedRounds,
    outboxSettlements,
    executionSettlements,
    channelResults,
    madeProgress:
      observerRuns +
        deliveries +
        plannedRounds +
        outboxSettlements +
        executionSettlements +
        channelResults >
      0,
  }
}

export function startDigitalEmployeeOsWorker(input: {
  readonly dependencies: DigitalEmployeeOsWorkerDependencies
  readonly intervalMs: number
  readonly onError: (error: unknown) => void
  readonly onCycle?: (result: DigitalEmployeeOsCycleResult) => void
}): { readonly stop: () => void; readonly runNow: () => Promise<void> } {
  let running = false
  let stopped = false
  const runNow = async (): Promise<void> => {
    if (running || stopped) return
    running = true
    try {
      const result = await runDigitalEmployeeOsCycle(input.dependencies)
      input.onCycle?.(result)
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
