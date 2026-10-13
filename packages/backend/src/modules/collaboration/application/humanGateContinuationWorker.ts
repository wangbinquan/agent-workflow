// RFC-341 — continuous owner of already-admitted RFC-333 gate continuations.

import {
  defineAuthorityManagedWorker,
  type AuthorityManagedWorkerDefinition,
  type BackgroundExecutionLifetime,
} from '@/platform/background/definitions'
import { createWakeLatch } from '@/platform/events/committed/workerDefinitions'

export type PendingHumanGateContinuation = Readonly<{
  taskId: string
  continuationRef: string
}>

export interface HumanGateContinuationWorkerCycle {
  readonly attempted: number
  readonly completed: number
  readonly failed: number
}

export function createHumanGateContinuationWorkerDefinition(input: {
  readonly listPending: () => Promise<readonly PendingHumanGateContinuation[]>
  readonly drive: (continuation: PendingHumanGateContinuation) => Promise<void>
  readonly reconcileMs?: number
  readonly now?: () => number
  readonly onError?: (input: PendingHumanGateContinuation & { error: unknown }) => void
}): Readonly<{
  definition: Readonly<AuthorityManagedWorkerDefinition>
  nudge: () => void
  runCycle: () => Promise<HumanGateContinuationWorkerCycle>
}> {
  const now = input.now ?? Date.now
  const reconcileMs = input.reconcileMs ?? 1_000
  const latch = createWakeLatch()
  let readiness: 'starting' | 'ready' | 'stopped' | 'degraded' = 'stopped'
  let running = false
  let cycles = 0
  let attempted = 0
  let completed = 0
  let failed = 0
  let lastError: string | null = null

  const runCycle = async (
    execution?: BackgroundExecutionLifetime,
  ): Promise<HumanGateContinuationWorkerCycle> => {
    if (execution !== undefined && !execution.current())
      return { attempted: 0, completed: 0, failed: 0 }
    const pending = await input.listPending()
    let cycleAttempted = 0
    let cycleCompleted = 0
    let cycleFailed = 0
    for (const continuation of pending) {
      if (execution !== undefined && !execution.current()) break
      cycleAttempted += 1
      try {
        await input.drive(continuation)
        cycleCompleted += 1
      } catch (error) {
        cycleFailed += 1
        lastError = error instanceof Error ? error.message : String(error)
        input.onError?.({ ...continuation, error })
      }
    }
    cycles += 1
    attempted += cycleAttempted
    completed += cycleCompleted
    failed += cycleFailed
    return { attempted: cycleAttempted, completed: cycleCompleted, failed: cycleFailed }
  }

  const definition = defineAuthorityManagedWorker({
    supportsExecutionLifetime: true,
    id: 'human-gate-continuation',
    owner: 'collaboration',
    kind: 'long-running',
    phase: 'after-ready',
    dependencies: ['task-execution'],
    readiness: () => readiness,
    state: () => ({ running, cycles, attempted, completed, failed, lastError }),
    start() {
      readiness = 'starting'
    },
    async run(context) {
      running = true
      readiness = 'ready'
      try {
        while (!context.signal.aborted) {
          if (context.execution !== undefined && !context.execution.current()) break
          await runCycle(context.execution)
          if (context.execution !== undefined && !context.execution.current()) break
          await latch.wait(reconcileMs, context.signal)
        }
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
        readiness = 'degraded'
        throw error
      } finally {
        running = false
        if (readiness !== 'degraded') readiness = 'stopped'
      }
    },
    stop() {
      latch.wake()
      readiness = 'stopped'
    },
    health() {
      return {
        status:
          readiness === 'stopped' ? 'stopped' : readiness === 'degraded' ? 'unhealthy' : 'healthy',
        checkedAt: new Date(now()).toISOString(),
        ...(lastError === null ? {} : { reason: lastError }),
      }
    },
  })
  return { definition, nudge: () => latch.wake(), runCycle }
}
