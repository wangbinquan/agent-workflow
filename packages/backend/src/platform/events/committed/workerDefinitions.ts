// RFC-341 — W3-owned managed definitions.  W9 may register these definitions
// globally later without changing either worker body.

import {
  defineManagedWorker,
  type ManagedWorkerDefinition,
} from '@/platform/background/definitions'
import type { CommittedEventDispatcher } from './dispatcherWorker'
import type { CommittedEventDeliveryPersistencePort } from './persistence'

interface WakeLatch {
  wait(ms: number, signal: AbortSignal): Promise<void>
  wake(): void
}

export function createWakeLatch(): WakeLatch {
  let waiter: (() => void) | null = null
  let pending = false
  return {
    wait(ms, signal) {
      if (pending || signal.aborted) {
        pending = false
        return Promise.resolve()
      }
      return new Promise<void>((resolve) => {
        let settled = false
        const settle = (): void => {
          if (settled) return
          settled = true
          waiter = null
          clearTimeout(timer)
          signal.removeEventListener('abort', settle)
          resolve()
        }
        const timer = setTimeout(settle, ms)
        waiter = settle
        signal.addEventListener('abort', settle, { once: true })
      })
    },
    wake() {
      pending = true
      waiter?.()
    },
  }
}

export function createCommittedEventDispatcherWorkerDefinition(input: {
  readonly persistence: CommittedEventDeliveryPersistencePort
  readonly dispatcher: CommittedEventDispatcher
  readonly reconcileMs?: number
  readonly now?: () => number
}): Readonly<{
  definition: Readonly<ManagedWorkerDefinition>
  nudge: () => void
}> {
  const now = input.now ?? Date.now
  const reconcileMs = input.reconcileMs ?? 1_000
  const latch = createWakeLatch()
  let readiness: 'starting' | 'ready' | 'stopped' | 'degraded' = 'stopped'
  let running = false
  let cycles = 0
  let deliveries = 0
  let lastError: string | null = null

  const definition = defineManagedWorker({
    id: 'committed-event-dispatcher',
    owner: 'platform.events.committed',
    kind: 'long-running',
    phase: 'after-ready',
    dependencies: ['sqlite', 'event-center'],
    readiness: () => readiness,
    state: () => ({ running, cycles, deliveries, lastError }),
    start() {
      readiness = 'starting'
    },
    async run(context) {
      running = true
      readiness = 'ready'
      try {
        while (!context.signal.aborted) {
          const result = await input.dispatcher.drain(32)
          cycles += 1
          deliveries += result.steps
          if (!result.madeProgress) await latch.wait(reconcileMs, context.signal)
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
    async health() {
      const health = await input.persistence.health()
      const unhealthy = health.deadLetter > 0 || readiness === 'degraded'
      return {
        status: readiness === 'stopped' ? 'stopped' : unhealthy ? 'unhealthy' : 'healthy',
        checkedAt: new Date(now()).toISOString(),
        ...(unhealthy
          ? {
              reason: health.lastErrorSummary ?? lastError ?? 'committed event dead-letter present',
            }
          : {}),
      }
    },
  })
  return { definition, nudge: () => latch.wake() }
}

export function startManagedWorkerDefinition(
  definition: Readonly<ManagedWorkerDefinition>,
  daemonGeneration: string,
): Readonly<{ stop(reason?: string): Promise<void>; done: Promise<void> }> {
  const controller = new AbortController()
  definition.start({ signal: controller.signal, daemonGeneration })
  const done = definition.run({ signal: controller.signal, daemonGeneration })
  return {
    async stop(reason = 'daemon-stopping') {
      if (!controller.signal.aborted) controller.abort(reason)
      await definition.stop(reason)
      await done
    },
    done,
  }
}
