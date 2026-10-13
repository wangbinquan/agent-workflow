import type { Config } from '@agent-workflow/shared'
import { waitForExecutionActivation } from '@/platform/background/activation'

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
  readonly authorityCurrent?: () => boolean
  readonly batches: Set<ResumptionBatch>
  readonly reportingFailures: unknown[]
  readonly activation: AbortController
  activating?: Promise<void>
}

/** Own only queued admission, not the subsequently dispatched Intent turns. */
export function createQueuedIntentResumption(input: QueuedIntentResumptionDependencies) {
  const pending = new Set<string>()
  let current: ResumptionLifetime | null = null

  const deferIfAuthorityLost = (
    lifetime: ResumptionLifetime,
    sessionIds: readonly string[],
  ): boolean => {
    if (lifetime.authorityCurrent === undefined || lifetime.authorityCurrent()) return false
    for (const sessionId of sessionIds) pending.add(sessionId)
    return true
  }

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
          if (deferIfAuthorityLost(lifetime, ids)) return
          const config = await input.readConfiguration()
          if (lifetime.stopped) return
          if (deferIfAuthorityLost(lifetime, ids)) return
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

  const startLifetime = (authorityCurrent?: () => boolean, whenActive?: Promise<boolean>) => {
    if (current !== null) throw new Error('intent-queued-resumption-already-started')
    const lifetime: ResumptionLifetime = {
      stopped: false,
      ...(authorityCurrent === undefined ? {} : { authorityCurrent }),
      batches: new Set(),
      reportingFailures: [],
      activation: new AbortController(),
    }
    current = lifetime
    const handle = Object.freeze({
      stop(): void {
        if (lifetime.stopped) return
        lifetime.stopped = true
        lifetime.activation.abort()
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
        await lifetime.activating
        if (lifetime.reportingFailures.length > 0) {
          throw new AggregateError(
            lifetime.reportingFailures,
            'intent queued resumption error reporting failed',
          )
        }
        if (current === lifetime) current = null
      },
    })
    const resumePending = () => {
      if (lifetime.stopped || pending.size === 0 || (authorityCurrent && !authorityCurrent()))
        return
      const sessionIds = [...pending]
      pending.clear()
      admit(lifetime, sessionIds)
    }
    if (whenActive)
      lifetime.activating = waitForExecutionActivation(whenActive, lifetime.activation.signal).then(
        (active) => {
          if (active) resumePending()
        },
      )
    else resumePending()
    return handle
  }

  return Object.freeze({
    enqueue(sessionIds: readonly string[]): void {
      if (sessionIds.length === 0) return
      if (current === null || current.stopped) {
        for (const sessionId of sessionIds) pending.add(sessionId)
        return
      }
      if (deferIfAuthorityLost(current, sessionIds)) return
      admit(current, sessionIds)
    },
    start() {
      return startLifetime()
    },
    startAuthority(authority: {
      readonly current: () => boolean
      readonly whenActive?: Promise<boolean>
      readonly canDispatch?: () => boolean
    }) {
      const selectedCurrent = authority.current
      if (typeof selectedCurrent !== 'function')
        throw new Error('intent-queued-resumption-current-missing')
      const dispatch = authority.canDispatch?.bind(authority)
      return startLifetime(
        () => selectedCurrent.call(authority) && (dispatch?.() ?? true),
        authority.whenActive,
      )
    },
  })
}
