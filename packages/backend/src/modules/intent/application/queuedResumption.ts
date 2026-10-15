import type { Config } from '@agent-workflow/shared'

export interface QueuedIntentResumptionDependencies {
  readonly readConfiguration: () => Config | Promise<Config>
  readonly resume: (sessionIds: readonly string[], config: Config) => Promise<void>
  readonly onError: (error: unknown) => void | Promise<void>
}

interface ResumptionBatch {
  readonly sessionIds: readonly string[]
  admitted: boolean
  readonly done: Promise<void>
}

interface ResumptionLifetime {
  stopped: boolean
  readonly batches: Set<ResumptionBatch>
  readonly reportingFailures: unknown[]
}

/** Own only queued admission, not the subsequently dispatched Intent turns. */
export function createQueuedIntentResumption(input: QueuedIntentResumptionDependencies) {
  const pending = new Set<string>()
  let current: ResumptionLifetime | null = null

  const admit = (lifetime: ResumptionLifetime, sessionIds: readonly string[]): void => {
    const ids = Object.freeze([...sessionIds])
    const batch: ResumptionBatch = {
      sessionIds: ids,
      admitted: false,
      // Register the complete lifetime before either the selected read or the
      // admission can run, including a synchronous reader or rejection.
      done: Promise.resolve()
        .then(async () => {
          if (lifetime.stopped) return
          const config = await input.readConfiguration()
          if (lifetime.stopped) return
          batch.admitted = true
          await input.resume(ids, config)
        })
        .catch(async (error: unknown) => {
          try {
            await input.onError(error)
          } catch (reportingError) {
            lifetime.reportingFailures.push(reportingError)
          }
        })
        .finally(() => {
          lifetime.batches.delete(batch)
        }),
    }
    lifetime.batches.add(batch)
  }

  return Object.freeze({
    enqueue(sessionIds: readonly string[]): void {
      if (sessionIds.length === 0) return
      if (current === null || current.stopped) {
        for (const sessionId of sessionIds) pending.add(sessionId)
        return
      }
      admit(current, sessionIds)
    },
    start() {
      if (current !== null) throw new Error('intent-queued-resumption-already-started')
      const lifetime: ResumptionLifetime = {
        stopped: false,
        batches: new Set(),
        reportingFailures: [],
      }
      current = lifetime
      const handle = Object.freeze({
        stop(): void {
          if (lifetime.stopped) return
          lifetime.stopped = true
          // Retain unread/unadmitted IDs for this same composition's rollback.
          // Already admitted work settles against its original provider.
          for (const batch of lifetime.batches) {
            if (!batch.admitted) {
              for (const sessionId of batch.sessionIds) pending.add(sessionId)
            }
          }
        },
        async drain(): Promise<void> {
          if (!lifetime.stopped) throw new Error('intent-queued-resumption-drain-before-stop')
          await Promise.all([...lifetime.batches].map((batch) => batch.done))
          if (lifetime.reportingFailures.length > 0) {
            throw new AggregateError(
              lifetime.reportingFailures,
              'intent queued resumption error reporting failed',
            )
          }
          if (current === lifetime) current = null
        },
      })
      if (pending.size > 0) {
        const sessionIds = [...pending]
        pending.clear()
        admit(lifetime, sessionIds)
      }
      return handle
    },
  })
}
