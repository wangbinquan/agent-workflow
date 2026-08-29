// RFC-341 — continuous owner of already-admitted RFC-333 gate continuations.

import type { DbClient } from '@/db/client'
import {
  defineManagedWorker,
  type ManagedWorkerDefinition,
} from '@/platform/background/definitions'
import { createWakeLatch } from '@/platform/events/committed/workerDefinitions'
import {
  listPendingHumanGateContinuations,
  type PendingHumanGateContinuation,
} from '@/services/humanGateContinuationRecovery'

export interface HumanGateContinuationWorkerCycle {
  readonly attempted: number
  readonly completed: number
  readonly failed: number
}

export function createHumanGateContinuationWorkerDefinition(input: {
  readonly db: DbClient
  readonly drive: (continuation: PendingHumanGateContinuation) => Promise<void>
  readonly reconcileMs?: number
  readonly now?: () => number
  readonly onError?: (input: PendingHumanGateContinuation & { error: unknown }) => void
}): Readonly<{
  definition: Readonly<ManagedWorkerDefinition>
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

  const runCycle = async (): Promise<HumanGateContinuationWorkerCycle> => {
    const pending = listPendingHumanGateContinuations(input.db)
    let cycleCompleted = 0
    let cycleFailed = 0
    for (const continuation of pending) {
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
    attempted += pending.length
    completed += cycleCompleted
    failed += cycleFailed
    return { attempted: pending.length, completed: cycleCompleted, failed: cycleFailed }
  }

  const definition = defineManagedWorker({
    id: 'human-gate-continuation',
    owner: 'collaboration',
    kind: 'long-running',
    phase: 'after-ready',
    dependencies: ['task-execution', 'sqlite'],
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
          await runCycle()
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
